const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const version = require('./version.json')
const root = path.resolve(__dirname, '../..')
const distribution = path.join(root, 'desktop/build', `Sparkle-${version.version}`)

async function prepare({ compile = true } = {}) {
  if (process.platform !== 'darwin') return
  const archive = `${distribution}.tar.xz`
  await fs.mkdir(path.dirname(archive), { recursive: true })
  let bytes
  try { bytes = await fs.readFile(archive) } catch { /* First build. */ }
  if (!bytes) {
    const response = await fetch(version.url, { signal: AbortSignal.timeout(120000) })
    if (!response.ok) throw new Error(`Sparkle download failed (${response.status}).`)
    bytes = Buffer.from(await response.arrayBuffer())
  }
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== version.sha256) throw new Error('Sparkle archive checksum does not match the pinned release.')
  await fs.writeFile(archive, bytes)
  const marker = path.join(distribution, '.verified-sha256')
  const verified = await fs.readFile(marker, 'utf8').catch(() => '')
  if (verified !== version.sha256) {
    await fs.rm(distribution, { recursive: true, force: true })
    await fs.mkdir(distribution, { recursive: true })
    execFileSync('/usr/bin/tar', ['-xf', archive, '-C', distribution])
    await fs.writeFile(marker, version.sha256)
  }
  if (compile) {
    const output = path.join(root, 'desktop/resources/native')
    await fs.mkdir(output, { recursive: true })
    execFileSync('xcrun', ['clang++', '-std=c++17', '-fobjc-arc', '-fblocks', '-bundle', '-undefined', 'dynamic_lookup',
      '-mmacosx-version-min=12.0', '-arch', process.arch === 'arm64' ? 'arm64' : 'x86_64', '-DNAPI_VERSION=8',
      '-I', require('node-api-headers').include_dir, '-F', distribution,
      '-framework', 'Foundation', '-framework', 'AppKit', '-framework', 'Sparkle',
      '-Wl,-rpath,@loader_path/../../Frameworks', path.join(__dirname, 'bridge.mm'),
      '-o', path.join(output, 'pdfer-sparkle.node')], { stdio: 'inherit' })
    console.log(`Built Sparkle ${version.version} bridge for ${process.arch}.`)
  }
  return distribution
}

module.exports = { prepare, distribution }
if (require.main === module) prepare().catch((error) => { console.error(error.message); process.exitCode = 1 })
