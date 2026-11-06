const { app, BrowserWindow, dialog, ipcMain, Menu, protocol, session } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { startBackend } = require('./backend.cjs')
const { createHandler, isAppURL, APP_URL } = require('./protocol.cjs')
const { Updates } = require('./updates.cjs')
const { OcrSetup } = require('./ocr.cjs')

protocol.registerSchemesAsPrivileged([{ scheme: 'pdfer', privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true,
} }])

function configureDataDir(provided) {
  // The manifest supplies the stable name. Isolated test builds use their own
  // manifest name so Sparkle relaunches into the same isolated profile.
  // Development and smoke tests must not change a user's installed-app projects.
  const dataDir = provided || process.env.PDFER_USER_DATA_DIR || (app.isPackaged ? app.getPath('userData') : path.join(app.getPath('appData'), 'pdfer-development'))
  fs.mkdirSync(dataDir, { recursive: true })
  app.setPath('userData', dataDir)
  return dataDir
}

async function launch(options = {}) {
  const root = path.resolve(__dirname, '..')
  const dataDir = configureDataDir(options.dataDir)
  await app.whenReady()
  let logBytes = 0
  const logFile = path.join(dataDir, 'desktop.log')
  fs.writeFileSync(logFile, '')
  const log = (text) => { if (logBytes < 1024 * 1024) { logBytes += Buffer.byteLength(text); fs.appendFileSync(logFile, text) } }
  log(`pdfer ${app.getVersion()} started\n`)
  const resources = options.resources || (app.isPackaged ? process.resourcesPath : path.join(root, 'desktop/resources'))
  const bundled = app.isPackaged || options.useBundledBackend
  const ocr = new OcrSetup({ source: bundled ? path.join(resources, 'ocr-runtime') : path.join(root, 'backend/ocr-runtime'),
    dataDir, uv: bundled ? path.join(resources, 'tools', process.platform === 'win32' ? 'uv.exe' : 'uv') : 'uv',
    log, notify: (value) => send('ocr:changed', value) })
  let window = null
  let installRequested = false
  let quitting = false
  let cleaned = false
  let backend
  let updates
  function send(channel, value) { if (window && !window.isDestroyed()) window.webContents.send(channel, value) }
  const cleanup = async () => {
    if (cleaned) return
    cleaned = true
    await Promise.allSettled([backend?.stop(), ocr.stop(), !installRequested ? updates?.updater.dispose?.() : undefined])
  }
  try {
    backend = await startBackend({
      command: bundled ? path.join(resources, 'pdfer-backend', process.platform === 'win32' ? 'pdfer-backend.exe' : 'pdfer-backend') : 'uv',
      args: bundled ? [] : ['run', '--project', path.join(root, 'backend'), '--frozen', 'python', '-m', 'pdfer.desktop'],
      cwd: bundled ? dataDir : root,
      env: { PDFER_DATA_DIR: dataDir, ...ocr.backendEnv() }, log,
      onExit: () => {
        if (quitting) return
        dialog.showErrorBox('Local PDF engine stopped', 'Please restart pdfer. Your saved projects are kept on this computer.')
        app.quit()
      },
    })
  } catch (error) { await cleanup(); throw error }

  let autoUpdater, updatesEnabled = false
  if (process.platform === 'darwin') {
    const configFile = path.join(resources, 'sparkle.json')
    const sparkleConfig = app.isPackaged && fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : {}
    updatesEnabled = sparkleConfig.enabled === true
    if (updatesEnabled) {
      const { SparkleUpdater } = require('./sparkle.cjs')
      autoUpdater = new SparkleUpdater(require(path.join(resources, 'native/pdfer-sparkle.node')), { log, feedURL: sparkleConfig.feedURL })
    } else {
      autoUpdater = new (require('node:events').EventEmitter)()
    }
  } else {
    autoUpdater = require('electron-updater').autoUpdater
    updatesEnabled = app.isPackaged && fs.existsSync(path.join(resources, 'app-update.yml'))
  }
  updates = new Updates(autoUpdater, { enabled: updatesEnabled,
    version: app.getVersion(), notify: (value) => send('updates:changed', value) })
  let installationFailed = false
  const reportInstallFailure = () => {
    if (installationFailed) return
    installationFailed = true
    dialog.showErrorBox('Could not install the update', 'Reopen pdfer to try again, or install the latest release manually. Your saved projects are kept in the app data folder.')
    app.quit()
  }
  autoUpdater.on('error', () => { if (installRequested && quitting) reportInstallFailure() })
  protocol.handle('pdfer', createHandler(options.frontendRoot || (app.isPackaged ? path.join(resources, 'frontend') : path.join(root, 'frontend/dist')), backend))
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    callback(permission === 'clipboard-sanitized-write' && isAppURL(contents.getURL()))
  })
  session.defaultSession.setPermissionCheckHandler((_contents, permission, origin) => permission === 'clipboard-sanitized-write' && isAppURL(origin))
  // Only the packaged UI and its local data can be requested by the renderer.
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !(isAppURL(details.url) || details.url.startsWith('blob:pdfer://app/') || details.url.startsWith('data:')) })
  })
  session.defaultSession.on('will-download', (_event, item) => {
    item.setSaveDialogOptions({ title: 'Save exported file', defaultPath: path.join(app.getPath('downloads'), path.basename(item.getFilename())) })
  })
  window = new BrowserWindow({ title: 'pdfer', width: 1120, height: 900, minWidth: 720, minHeight: 600,
    show: false, backgroundColor: '#fafafa', webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false,
      sandbox: true, webSecurity: true, spellcheck: false,
    } })
  const contents = window.webContents
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (event, url) => { if (!isAppURL(url)) event.preventDefault() })
  contents.on('will-frame-navigate', (event) => { if (!isAppURL(event.url)) event.preventDefault() })
  contents.on('will-attach-webview', (event) => event.preventDefault())
  contents.on('will-prevent-unload', (event) => {
    const answer = dialog.showMessageBoxSync(window, { type: 'warning', title: 'Unsaved changes',
      message: 'Some project changes have not been saved.',
      detail: 'Keep editing to finish saving, or discard those changes.',
      buttons: ['Keep editing', installRequested ? 'Discard and update' : 'Discard changes'], defaultId: 0, cancelId: 0 })
    if (answer === 1) event.preventDefault() // Electron: prevent the prevention to allow closing.
    else installRequested = false
  })
  const trusted = (event) => event.sender === contents && event.senderFrame === contents.mainFrame && isAppURL(event.senderFrame.url)
  const handle = (name, action) => ipcMain.handle(name, (event) => {
    if (!trusted(event)) throw new Error('This action is only available in pdfer.')
    return action()
  })
  handle('updates:state', () => updates.state)
  handle('updates:check', () => updates.check())
  handle('updates:download', () => updates.download())
  handle('updates:install', () => {
    if (updates.state.status !== 'downloaded' || ocr.state.status === 'installing') return false
    installRequested = true
    setImmediate(() => window?.close())
    return true
  })
  handle('ocr:state', () => ocr.state)
  handle('ocr:install', () => { void ocr.install(); return ocr.state })
  window.on('closed', () => {
    window = null
    if (installRequested) {
      quitting = true
      void cleanup().then(() => autoUpdater.quitAndInstall(false, true)).catch(reportInstallFailure)
    }
  })
  app.on('window-all-closed', () => { if (!installRequested) app.quit() })
  process.on('SIGTERM', () => app.quit())
  process.on('SIGINT', () => app.quit())
  app.on('will-quit', (event) => {
    quitting = true
    if (!cleaned) { event.preventDefault(); void cleanup().then(() => app.quit()) }
  })
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus() } })
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [{ role: 'quit' }] }, { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' },
      ...(!app.isPackaged ? [{ role: 'toggleDevTools' }] : [])] },
    { label: 'Help', submenu: [{ label: 'Check for updates…', enabled: updates.state.status !== 'disabled',
      click: () => { window?.show(); void updates.check() } }] },
  ]))
  await window.loadURL(APP_URL)
  if (options.show !== false) window.show()
  log(`pdfer ${app.getVersion()} ready\n`)
  if (updates.state.status !== 'disabled') {
    const timer = setTimeout(() => { void updates.check() }, 10000)
    timer.unref()
    const interval = setInterval(() => { void updates.check() }, 4 * 60 * 60 * 1000)
    interval.unref()
  }
  return { window, backend, updates, ocr, cleanup, dataDir }
}

if (require.main === module) {
  configureDataDir()
  if (!app.requestSingleInstanceLock()) app.quit()
  else launch().catch((error) => {
    dialog.showErrorBox('Could not start pdfer', `${error.message}\n\nPlease reinstall the app if this continues.`)
    app.quit()
  })
}

module.exports = { launch }
