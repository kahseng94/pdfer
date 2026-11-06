// State transitions are kept separate from Electron to exercise failure/retry paths.
class Updates {
  constructor(updater, { enabled, version, notify = () => {} }) {
    this.updater = updater
    this.notify = notify
    this.busy = false
    this.state = { status: enabled ? 'idle' : 'disabled', currentVersion: version }
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = false
    updater.allowPrerelease = false
    updater.channel = `latest-${process.arch}`
    updater.allowDowngrade = false
    updater.on('update-available', (info) => this.set({ status: 'available', version: info.version, message: undefined }))
    updater.on('update-not-available', (info) => this.set({ status: 'idle', version: undefined, percent: undefined,
      message: info?.noPublishedRelease ? 'No published stable release is available yet.' : 'You’re up to date.' }))
    updater.on('download-progress', (progress) => this.set({ status: 'downloading', percent: Math.round(progress.percent) }))
    updater.on('update-downloaded', (info) => this.set({ status: 'downloaded', version: info.version, percent: 100, message: undefined }))
    updater.on('error', () => this.failed())
  }
  set(change) { this.state = { ...this.state, ...change }; this.notify(this.state) }
  failed() {
    // A failed recheck must never erase an update that is already ready to install.
    if (this.state.status === 'downloaded' && !this.updater.downloadRetryRequiresCheck) return
    this.set({ status: this.state.version && !this.updater.downloadRetryRequiresCheck ? 'available' : 'error', message: 'Could not fetch or verify the update. Check your connection and try again.' })
  }
  async check() {
    if (this.busy || ['disabled', 'checking', 'available', 'downloading', 'downloaded'].includes(this.state.status)) return this.state
    this.busy = true
    this.set({ status: 'checking', message: undefined, version: undefined, percent: undefined })
    try { await this.updater.checkForUpdates() } catch { this.failed() } finally { this.busy = false }
    return this.state
  }
  async download() {
    if (this.busy || this.state.status !== 'available') return this.state
    this.busy = true
    this.set({ status: 'downloading', message: undefined, percent: 0 })
    try { await this.updater.downloadUpdate() } catch { this.failed() } finally { this.busy = false }
    return this.state
  }
}

module.exports = { Updates }
