const Zip = require('./zip')
const { mapInfoResource, getBase64FromBuffer } = require('./utils')
const ManifestName = /^androidmanifest\.xml$/
const ResourceName = /^resources\.arsc$/
const LibName = /^lib[\\/]/

const AdaptiveIconParser = require('./xml-parser/adaptive-icon')
const ManifestXmlParser = require('./xml-parser/manifest')
const ResourceFinder = require('./resource-finder')

class ApkParser extends Zip {
  /**
   * parser for parsing .apk file
   * @param {String | File | Blob} file // file's path in Node, instance of File or Blob in Browser
   */
  constructor (file) {
    super(file)
    if (!(this instanceof ApkParser)) {
      return new ApkParser(file)
    }
  }
  parse (encoding) {
    this.encoding = encoding
    return new Promise(async (resolve, reject) => {
      try {
        const buffers = await this.getEntries([ManifestName, ResourceName, LibName]);
        for (let key of [ManifestName, ResourceName]) {
          buffers[key] = buffers[key][0].buffer
        }
        if (!buffers[ManifestName]) {
          throw new Error('AndroidManifest.xml can\'t be found.')
        }
        let apkInfo = this._parseManifest(buffers[ManifestName])
        let resourceMap
        if (!buffers[ResourceName]) {
          resolve(apkInfo)
        } else {
          // parse resourceMap
          resourceMap = this._parseResourceMap(buffers[ResourceName])
          // update apkInfo with resourceMap
          apkInfo = mapInfoResource(apkInfo, resourceMap)
          apkInfo.icon = null
          apkInfo.adaptiveIcons = null
          if (buffers[LibName]) {
            apkInfo.arch = [...new Set(buffers[LibName].map(item => item.fileName.match(/^lib[\\/](.*)[\\/]/)[1]))]
          }
          // find icon path and parse icon
          const adaptiveIcons = apkInfo.application.icon.filter(icon => icon.value.endsWith('.xml'))
          const imageIcons = apkInfo.application.icon.filter(icon => icon.value.endsWith('.png') || icon.value.endsWith('.jpg'))
          if (adaptiveIcons.length) {
            try {
              const icons = await Promise.all(adaptiveIcons.map(icon => this.getEntry(icon.value)));
              const adaptiveIconBuffer = icons.sort((a, b) => b.length - a.length)[0]
              const adaptiveIconParser = new AdaptiveIconParser(adaptiveIconBuffer, resourceMap)
              apkInfo.adaptiveIcons = await this._getAdaptiveIconBuffers(adaptiveIconParser.parse())
            } catch (e) {
              console.warn('[Warning] failed to parse adaptive icon: ', e)
            }
          }
          if (imageIcons.length) {
            try {
              const icons = await Promise.all(imageIcons.map(icon => this.getEntry(icon.value)))
              const iconBuffer = icons.sort((a, b) => b.length - a.length)[0]
              apkInfo.icon = iconBuffer ? this.encoding === 'base64' ? getBase64FromBuffer(iconBuffer) : iconBuffer : null
            } catch (e) {
              console.warn('[Warning] failed to parse icon: ', e)
            }
          }
          resolve(apkInfo)
        }
      } catch (e) {
        reject(e);
      }
    })
  }
  _getAdaptiveIconBuffers (icons) {
    const iconBuffers = {}
    const pending = []
    for (let key of Object.keys(icons)) {
      pending.push(this.getEntry(icons[key]).then(buffer => {
        iconBuffers[key] = this.encoding === 'base64' ? getBase64FromBuffer(buffer) : buffer
      }))
    }
    return Promise.allSettled(pending).then(() => iconBuffers)
  }
  /**
   * Parse manifest
   * @param {Buffer} buffer // manifest file's buffer
   */
  _parseManifest (buffer) {
    try {
      const parser = new ManifestXmlParser(buffer, {
        ignore: [
          'application.activity',
          'application.service',
          'application.receiver',
          'application.provider',
          'permission-group'
        ]
      })
      return parser.parse()
    } catch (e) {
      throw new Error('Parse AndroidManifest.xml error: ', e)
    }
  }
  /**
   * Parse resourceMap
   * @param {Buffer} buffer // resourceMap file's buffer
   */
  _parseResourceMap (buffer) {
    try {
      return new ResourceFinder().processResourceTable(buffer)
    } catch (e) {
      throw new Error('Parser resources.arsc error: ' + e)
    }
  }
}

module.exports = ApkParser
