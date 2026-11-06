const fs = require('node:fs')
const path = require('node:path')
const { releaseSettings } = require('./release-config.cjs')
const { distribution } = require('./sparkle/prepare.cjs')

const settings = releaseSettings()

module.exports = {
  appId: 'com.pdfer.desktop', productName: 'pdfer',
  directories: { output: process.env.PDFER_OUTPUT_DIR || 'release', buildResources: 'desktop/assets' },
  files: ['desktop/*.cjs', '!desktop/electron-builder.cjs', '!desktop/release-config.cjs', 'package.json'],
  ...(process.env.PDFER_BUILD_VERSION ? { extraMetadata: { version: process.env.PDFER_BUILD_VERSION } } : {}),
  beforePack: () => {
    if (!fs.existsSync(path.join(__dirname, 'resources/pdfer-backend'))) throw new Error('Run pnpm desktop:backend first.')
  },
  afterPack: async ({ appOutDir, packager, electronPlatformName }) => {
    if (electronPlatformName === 'darwin') {
      await fs.promises.writeFile(path.join(packager.getResourcesDir(appOutDir), 'sparkle.json'), JSON.stringify({ enabled: settings.sparkleEnabled, feedURL: settings.feedURL }))
    }
  },
  extraResources: [
    { from: 'frontend/dist', to: 'frontend' },
    { from: 'desktop/resources/pdfer-backend', to: 'pdfer-backend' },
    { from: 'desktop/resources/tools', to: 'tools' },
    { from: 'desktop/resources/ocr-runtime', to: 'ocr-runtime' },
    { from: 'desktop/THIRD_PARTY.md', to: 'THIRD_PARTY.md' },
  ],
  asar: true, npmRebuild: false,
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
  forceCodeSigning: settings.forceCodeSigning,
  generateUpdatesFilesForAllChannels: false,
  // macOS uses signed Sparkle feeds; NSIS/AppImage continue using electron-updater.
  publish: process.platform === 'darwin' ? null : settings.publish,
  mac: { category: 'public.app-category.productivity', target: ['dmg', 'zip'],
    identity: settings.osSigning ? undefined : '-',
    hardenedRuntime: settings.osSigning, notarize: settings.notarize,
    extraFiles: [{ from: path.join(distribution, 'Sparkle.framework'), to: 'Frameworks/Sparkle.framework' }],
    extraResources: [{ from: 'desktop/resources/native', to: 'native' }],
    extendInfo: {
      ...(settings.publicKey ? { SUPublicEDKey: settings.publicKey } : {}),
      ...(settings.feedURL ? { SUFeedURL: settings.feedURL } : {}),
      SUEnableAutomaticChecks: false, SUAutomaticallyUpdate: false, SUAllowsAutomaticUpdates: false,
      SUEnableSystemProfiling: false, SUShowReleaseNotes: false,
      SUVerifyUpdateBeforeExtraction: true, SURequireSignedFeed: true,
      ...(!settings.release && settings.feedURL?.startsWith('http:') ? { NSAppTransportSecurity: { NSAllowsLocalNetworking: true } } : {}),
    } },
  win: { target: ['nsis'] },
  nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false, createDesktopShortcut: true },
  linux: { target: ['AppImage'], category: 'Office', maintainer: 'Jayson Ng' },
}
