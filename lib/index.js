// File and Dataset objects
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const stream = require('stream')
const url = require('url')

const chardet = require('chardet')
const fetch = require('node-fetch')
const lodash = require('lodash')
const mime = require('mime-types')
const urljoin = require('url-join')
const toArray = require('stream-to-array')
const infer = require('tableschema').infer

const {csvParser} = require('./parser/csv')
const {xlsxParser} = require('./parser/xlsx')

const DEFAULT_ENCODING = 'utf-8'

class File {

  static load(pathOrDescriptor, {basePath, format} = {}) {
    let descriptor = null
    if (lodash.isPlainObject(pathOrDescriptor)) {
      descriptor = lodash.cloneDeep(pathOrDescriptor)
      // NB: data must come first - we could have data and path in which path
      // is not used (data comes from data)
      if (descriptor.data) {
        return new FileInline(descriptor, {basePath})
      } else if (descriptor.path) {
        // We want properties already in our descriptor to take priority over
        // those inferred from path so we assign in this order
        descriptor = Object.assign(parsePath(descriptor.path, basePath), descriptor)
      }
    } else if (lodash.isString(pathOrDescriptor)) {
      descriptor = parsePath(pathOrDescriptor, basePath, format)
    } else {
      throw new TypeError(`Cannot create File with ${pathOrDescriptor}`)
    }

    const isRemote = (descriptor.pathType === 'remote' || isUrl(basePath))

    if (isRemote) {
      return new FileRemote(descriptor, {basePath})
    }
    return new FileLocal(descriptor, {basePath})
  }

  constructor(descriptor, {basePath} = {}) {
    this._descriptor = descriptor
    this._basePath = basePath
  }

  get descriptor() {
    return this._descriptor
  }

  get path() {
    throw new Error('This is an abstract base class which you should not instantiate. Use .load() instead')
  }

  stream() {
    return null
  }

  get buffer() {
    return (async () => {
      const stream = await this.stream()
      const buffers = await toArray(stream)
      return Buffer.concat(buffers)
    })()
  }

  rows({keyed} = {}) {
    return this._rows({keyed})
  }

  _rows({keyed} = {}) {
    if (this.descriptor.format in parserDatabase) {
      const parser = parserDatabase[this.descriptor.format]
      return parser(this, keyed)
    }
    throw new Error(`We do not have a parser for that format: ${this.descriptor.format}`)
  }

  async addSchema() {
    // Ensure file is tabular
    if (knownTabularFormats.indexOf(this.descriptor.format) === -1) {
      throw new Error('File is not in known tabular format.')
    }
    const stream = await this.stream()
    this.descriptor.schema = await infer(stream)
  }
}

class FileLocal extends File {
  get path() {
    return this._basePath ? path.join(this._basePath, this.descriptor.path) : this.descriptor.path
  }

  stream() {
    return fs.createReadStream(this.path)
  }

  get size() {
    return fs.statSync(this.path).size
  }

  get hash() {
    return crypto.createHash('md5')
      .update(fs.readFileSync(this.path))
      .digest('base64')
  }

  get encoding() {
    return chardet.detectFileSync(this.path)
  }
}

class FileRemote extends File {
  get path() {
    return this._basePath ? urljoin(this._basePath, this.descriptor.path) : this.descriptor.path
  }

  stream() {
    return (async () => {
      const res = await fetch(this.path)
      return res.body
    })()
  }

  get encoding() {
    return DEFAULT_ENCODING
  }
}

class FileInline extends File {
  constructor(descriptor, {basePath} = {}) {
    super(descriptor, {basePath})

    // JSON is special case ...
    if (lodash.isString(this.descriptor.data)) {
      this._buffer = Buffer.from(this.descriptor.data)
    } else { // It is json/javascript
      this._buffer = Buffer.from(JSON.stringify(this.descriptor.data))
    }
  }

  // Not really sure this should exist here ... - have it for tests atm
  get path() {
    return this.descriptor.path
  }

  get size() {
    return this._buffer.byteLength
  }

  get hash() {
    return crypto.createHash('md5')
      .update(this._buffer)
      .digest('base64')
  }

  stream() {
    const bufferStream = new stream.PassThrough()
    bufferStream.end(this._buffer)
    return bufferStream
  }

  rows({keyed} = {}) {
    if (lodash.isArray(this.descriptor.data)) {
      const rowStream = new stream.PassThrough({objectMode: true})
      this.descriptor.data.forEach(row => {
        rowStream.write(row)
      })
      rowStream.end()
      return rowStream
    }
    return this._rows({keyed})
  }
}

// Available parsers per file format
const parserDatabase = {
  csv: csvParser,
  xlsx: xlsxParser,
  xls: xlsxParser
}

// List of formats that are known as tabular
const knownTabularFormats = ['csv', 'tsv', 'dsv']

const parsePath = (path_, basePath = null, format = null) => {
  let fileName
  const isItUrl = isUrl(path_) || isUrl(basePath)
  if (isItUrl) {
    const urlParts = url.parse(path_)
    // eslint-disable-next-line no-useless-escape
    fileName = urlParts.pathname.replace(/^.*[\\\/]/, '')
    // Check if format=csv is provided in the query
    // But if format is provided explicitely by user then it'll be used
    if (!format && urlParts.query && urlParts.query.includes('format=csv')) {
      format = 'csv'
    }
  } else {
    // eslint-disable-next-line no-useless-escape
    fileName = path_.replace(/^.*[\\\/]/, '')
  }

  const extension = path.extname(fileName)
  const descriptor = {
    path: path_,
    pathType: isItUrl ? 'remote' : 'local',
    name: fileName.replace(extension, ''),
    format: format ? format : extension.slice(1)
  }
  
  const mediatype = mime.lookup(path_)
  if (mediatype) {
    descriptor.mediatype = mediatype
  }

  return descriptor
}

const parseDatasetIdentifier = path_ => {
  const out = {
    name: '',
    owner: null,
    path: '',
    type: '',
    original: path_,
    version: ''
  }
  if (path_ === null || path_ === '') return out

  out.type = isUrl(path_) ? 'url' : 'local'
  let normalizedPath = path_.replace('/datapackage.json', '')
  normalizedPath = normalizedPath.replace(/\/$/, '')
  if (out.type === 'local') {
    out.path = path.posix.resolve(normalizedPath)
    out.name = path.basename(normalizedPath)
  } else if (out.type === 'url') {
    const urlparts = url.parse(normalizedPath)
    const parts = urlparts.pathname.split('/')
    let name = parts[parts.length - 1]
    let owner = null
    // is this a github repository?
    if (urlparts.host === 'github.com') {
      out.type = 'github'
      // yes, modify url for raw file server
      urlparts.host = 'raw.githubusercontent.com'
      owner = parts[1]
      let repoName = parts[2]
      let branch = 'master'

      // is the path a repository root?
      if(parts.length < 6){
          // yes, use the repository name for the package name
          name = repoName
      }

      // does the path contain subfolders (after the repository name)?
      if(parts.length == 3){
        // no, add 'master' branch
        parts.push(branch)
      } else {
        // yes, extract the branch and remove the 'tree' part
        branch = parts[4]
        parts.splice(3, 1)
      }

      urlparts.pathname = parts.join('/')
      out.version = branch
    } else if (urlparts.host === 'datahub.io') {
      out.type = 'datahub'
      urlparts.host = 'pkgstore.datahub.io'
      owner = parts[1]
      name = parts[2]
      parts.push('latest')
      urlparts.pathname = parts.join('/')
      out.version = 'latest'
    }
    out.name = name
    out.owner = owner
    out.path = url.format(urlparts) + '/'
  }

  return out
}

const isUrl = path_ => {
  const r = new RegExp('^(?:[a-z]+:)?//', 'i')
  return r.test(path_)
}

const isDataset = path_ => {
  // If it is a path to file we assume it is not a Dataset
  // Only exception is 'datapackage.json':
  if (path_.endsWith('datapackage.json')) {
    return true
  }
  const isItUrl = isUrl(path_)
  if (isItUrl) {
    // Guess by path_'s extension
    // Get path from url
    const pathFromUrl = url.parse(path_).path
    // Split path by dots
    const splitPath = pathFromUrl.split('.')
    const extension = splitPath.pop()
    if (!extension.includes('/')) {
      return false
    }
  } else if (fs.lstatSync(path_).isFile()) {
    return false
  }
  // All other cases are true
  return true
}

// ========================================================
// Dataset

class Dataset {
  // TODO: handle owner
  constructor(descriptor = {}, identifier = {path: null, owner: null}) {
    if (!lodash.isPlainObject(descriptor)) {
      throw new TypeError(`To create a new Dataset please use Dataset.load`)
    }

    this._descriptor = descriptor
    this._resources = []
    this._identifier = identifier
  }

  // eslint-disable-next-line no-unused-vars
  static async load(pathOrDescriptor, {owner = null} = {}) {
    if (
      !(lodash.isString(pathOrDescriptor) || lodash.isPlainObject(pathOrDescriptor))
    ) {
      throw new TypeError('Dataset needs to be created with descriptor Object or identifier string')
    }

    let descriptor, identifier = null

    if (lodash.isPlainObject(pathOrDescriptor)) {
      descriptor = pathOrDescriptor
      identifier = {
        path: null,
        owner: owner
      }
    } else { // pathOrDescriptor is a path
      descriptor = {}
      // TODO: owner if provided should override anything parsed from path
      identifier = parseDatasetIdentifier(pathOrDescriptor)
    }

    const dataset = new Dataset(descriptor, identifier)
    await dataset._sync()
    return dataset
  }

  // Bootstrap ourselves with {this.path}/datapackage.json and readme if exists
  async _sync() {
    const readmePath = this._path('README.md')
    // eslint-disable-next-line default-case
    switch (this.identifier.type) {
      case 'local': {
        this._descriptor = JSON.parse(fs.readFileSync(this.dataPackageJsonPath))
        // Now get README from local disk if exists
        if (fs.existsSync(readmePath)) {
          this._descriptor.readme  = fs.readFileSync(readmePath).toString()
        }
        break
      }
      case 'url':
      case 'github':
      case 'datahub': {
        let res = await fetch(this.dataPackageJsonPath)
        this._descriptor = await res.json()
        res = await fetch(readmePath)
        // May not exist and that is ok!
        if (res.status === 200) {
          this._descriptor.readme = await res.text()
        }
        break
      }
    }

    // handle case where readme was already inlined in the descriptor as readme
    // attribute as e.g. on the datahub

    // Now load each resource ...
    this._resources = this.descriptor.resources.map(resource => {
      return File.load(resource, {basePath: this.path})
    })
  }

  get identifier() {
    return this._identifier
  }

  get descriptor() {
    return this._descriptor
  }

  get path() {
    return this.identifier.path
  }

  get dataPackageJsonPath() {
    return this._path('datapackage.json')
  }

  get readme() {
    return this._descriptor.readme
  }

  // Array of File objects
  get resources() {
    return this._resources
  }

  addResource(resource) {
    if (lodash.isPlainObject(resource)) {
      this.descriptor.resources.push(resource)
      this.resources.push(File.load(resource))
    } else if (lodash.isObject(resource)) { // It is already a resource object!
      this.descriptor.resources.push(resource.descriptor)
      this.resources.push(resource)
    } else {
      throw new TypeError(`addResource requires a resource descriptor or an instantiated resources but got: ${resource}`)
    }
  }

  // Path relative to this dataset
  _path(offset = null) {
    const path_ = this.path ? this.path.replace('datapackage.json', '') : this.path
    // TODO: ensure offset is relative (security etc)
    switch (this.identifier.type) {
      case 'local':
        return path.join(path_, offset)
      case 'url':
        return urljoin(path_, offset)
      case 'github':
        return urljoin(path_, offset)
      case 'datahub':
        return urljoin(path_, offset)
      case undefined:
        return offset
      default:
        throw new Error(`Unknown path type: ${this.identifier.type}`)
    }
  }
}


module.exports = {
  File,
  FileLocal,
  FileRemote,
  FileInline,
  parsePath,
  parseDatasetIdentifier,
  isUrl,
  isDataset,
  Dataset,
  xlsxParser,
  csvParser
}
