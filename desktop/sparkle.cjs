const { EventEmitter } = require('node:events')
const { hasNoPublishedRelease } = require('./release-status.cjs')

// Matches the small updater interface used by Updates, while Sparkle owns all
// feed parsing, Ed25519 verification, extraction, replacement and relaunching.
class SparkleUpdater extends EventEmitter {
  constructor(native, { log = () => {}, feedURL, releaseLookup = hasNoPublishedRelease } = {}) {
    super()
    this.native = native
    this.log = log
    this.feedURL = feedURL
    this.releaseLookup = releaseLookup
    this.downloadRetryRequiresCheck = true
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject })
    // Startup failures also reach the UI when no check has been requested yet.
    void this.ready.catch(() => {})
    native.start((json) => this.receive(JSON.parse(json)))
  }
  receive(value) {
    if (['available', 'not-available', 'downloaded', 'error'].includes(value.event)) this.diagnostic?.abort()
    switch (value.event) {
      case 'ready': this.resolveReady(); break
      case 'available': this.emit('update-available', { version: value.version }); break
      case 'not-available': this.emit('update-not-available'); break
      case 'progress': this.emit('download-progress', { percent: value.percent }); break
      case 'downloaded': this.emit('update-downloaded', { version: value.version }); break
      case 'error': {
        const error = new Error(value.message || 'Sparkle could not update the application.')
        this.log(`${error.message}\n`)
        this.rejectReady(error)
        this.emit('error', error)
        break
      }
      case 'stopped': this.emit('stopped'); break
    }
  }
  async checkForUpdates() {
    await this.ready
    if (this.feedURL) {
      this.diagnostic?.abort()
      const diagnostic = this.diagnostic = new AbortController()
      const missing = await this.releaseLookup(this.feedURL, { signal: diagnostic.signal }).catch(() => false)
      if (diagnostic.signal.aborted || this.stopping) return
      if (missing) {
        this.log('No published stable release is available yet.\n')
        this.emit('update-not-available', { noPublishedRelease: true })
        return
      }
    }
    this.native.check()
  }
  async downloadUpdate() { await this.ready; this.native.download() }
  quitAndInstall() { this.native.install() }
  dispose() {
    if (!this.stopping) {
      this.diagnostic?.abort()
      this.stopping = new Promise((resolve) => {
        this.once('stopped', resolve)
        this.native.stop()
      })
    }
    return this.stopping
  }
}

module.exports = { SparkleUpdater }
