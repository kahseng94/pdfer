const { app, dialog } = require('electron')
const { configureDataDir, launch } = require('./main.cjs')

// Electron imports this entry in development. Start on load in both development and packaged builds.
configureDataDir()
if (app.requestSingleInstanceLock()) {
  launch().catch((error) => {
    dialog.showErrorBox('Could not start pdfer', `${error.message}\n\nPlease reinstall the app if this continues.`)
    app.quit()
  })
} else {
  app.quit()
}
