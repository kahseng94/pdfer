const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { readPrivateSeed, publicKeyFromSeed } = require('./keys.cjs')
const { releaseSettings } = require('../release-config.cjs')
const { distribution } = require('./prepare.cjs')

function xml(value) { return String(value).replace(/[<>&"']/g, (character) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[character])) }
function appcast({ version, url, signature, length, minimumSystemVersion = '12.0' }) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Invalid release version.')
  if (!Number.isSafeInteger(length) || length <= 0 || Buffer.from(signature, 'base64').length !== 64) throw new Error('Invalid signed archive metadata.')
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>pdfer updates</title>
    <item>
      <title>pdfer ${xml(version)}</title>
      <sparkle:version>${xml(version)}</sparkle:version>
      <sparkle:shortVersionString>${xml(version)}</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>${xml(minimumSystemVersion)}</sparkle:minimumSystemVersion>
      <enclosure url="${xml(url)}" sparkle:edSignature="${xml(signature)}" length="${length}" type="application/octet-stream" />
    </item>
  </channel>
</rss>
`
}

function signAppcast({ archive, output, version, url, seed, publicKey, minimumSystemVersion, tools = path.join(distribution, 'bin') }) {
  if (publicKeyFromSeed(seed) !== publicKey) throw new Error('SPARKLE_PRIVATE_KEY does not match the public key embedded in the app. Refusing to sign an unusable release.')
  const signer = path.join(tools, 'sign_update')
  const env = { ...process.env }
  delete env.SPARKLE_PRIVATE_KEY
  const run = (args) => execFileSync(signer, ['--ed-key-file', '-', ...args], { input: seed + '\n', encoding: 'utf8', env }).trim()
  const signature = run(['-p', archive])
  const length = fs.statSync(archive).size
  fs.writeFileSync(output, appcast({ version, url, signature, length, minimumSystemVersion }))
  // Sparkle authenticates the feed as well as the downloaded archive.
  run([output])
  run(['--verify', archive, signature])
  run(['--verify', output])
  return { signature, length }
}

function publish() {
  if (process.platform !== 'darwin') return
  const settings = releaseSettings()
  if (!settings.sparkleEnabled) return
  const version = process.env.PDFER_BUILD_VERSION || require('../../package.json').version
  const root = path.resolve(__dirname, '../..')
  const directory = process.env.PDFER_OUTPUT_DIR || path.join(root, 'release')
  const filename = `pdfer-${version}-mac-${process.arch}.zip`
  const archive = path.join(directory, filename)
  const output = path.join(directory, `appcast-${process.arch}.xml`)
  const bundle = path.join(directory, `mac${process.arch === 'x64' ? '' : '-' + process.arch}`, 'pdfer.app')
  const minimumSystemVersion = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :LSMinimumSystemVersion', path.join(bundle, 'Contents/Info.plist')], { encoding: 'utf8' }).trim()
  const url = `https://github.com/${settings.repository}/releases/download/v${version}/${filename}`
  signAppcast({ archive, output, version, url, seed: readPrivateSeed(), publicKey: settings.publicKey, minimumSystemVersion })
  console.log(`Signed and verified ${filename} and ${path.basename(output)}.`)
}

module.exports = { appcast, signAppcast }
if (require.main === module) {
  try { publish() } catch (error) { console.error(error.message); process.exitCode = 1 }
}
