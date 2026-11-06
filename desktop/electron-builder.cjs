const fs = require('node:fs')
const path = require('node:path')

// GitHub Actions supplies this automatically. Local builds can set the same value.
const repository = process.env.PDFER_RELEASE_REPOSITORY || process.env.GITHUB_REPOSITORY
if (repository && !/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('PDFER_RELEASE_REPOSITORY must be owner/repository.')
const [owner, repo] = (repository || '').split('/')
const release = process.env.PDFER_RELEASE === '1'
if (release && !repository) throw new Error('A release repository is required.')
if (release && ['darwin', 'win32'].includes(process.platform) && !process.env.CSC_LINK) throw new Error('Release builds require CSC_LINK and CSC_KEY_PASSWORD for code signing.')
if (release && process.platform === 'darwin' && !(process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER)) {
  throw new Error('macOS releases require Apple notarization API credentials.')
}
if (!fs.existsSync(path.join(__dirname, 'resources/pdfer-backend'))) throw new Error('Run pnpm desktop:backend first.')

module.exports = {
  appId: 'com.pdfer.desktop', productName: 'pdfer',
  directories: { output: 'release', buildResources: 'desktop/assets' },
  files: ['desktop/*.cjs', '!desktop/electron-builder.cjs', 'package.json'],
  extraResources: [
    { from: 'frontend/dist', to: 'frontend' },
    { from: 'desktop/resources/pdfer-backend', to: 'pdfer-backend' },
    { from: 'desktop/resources/tools', to: 'tools' },
    { from: 'desktop/resources/ocr-runtime', to: 'ocr-runtime' },
    { from: 'desktop/THIRD_PARTY.md', to: 'THIRD_PARTY.md' },
  ],
  asar: true, npmRebuild: false,
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
  forceCodeSigning: release && process.platform !== 'linux',
  generateUpdatesFilesForAllChannels: false,
  publish: repository && (release || process.env.PDFER_RELEASE_REPOSITORY) ? [{ provider: 'github', owner, repo, channel: `latest-${process.arch}`, releaseType: 'draft' }] : null,
  mac: { category: 'public.app-category.productivity', target: ['dmg', 'zip'],
    identity: !release && !process.env.CSC_LINK ? '-' : undefined,
    hardenedRuntime: release, notarize: release },
  win: { target: ['nsis'] },
  nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false, createDesktopShortcut: true },
  linux: { target: ['AppImage'], category: 'Office', maintainer: 'Jayson Ng' },
}
