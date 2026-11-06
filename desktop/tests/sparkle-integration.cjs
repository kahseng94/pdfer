// Test two real, ad-hoc-signed apps with a temporary feed and Ed25519 identity.
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { spawn, execFileSync } = require('node:child_process')
const { publicKeyFromSeed } = require('../sparkle/keys.cjs')
const { signAppcast } = require('../sparkle/publish.cjs')
const { connect } = require('./smoke.cjs')

const root = path.resolve(__dirname, '../..')
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(action, message, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const value = await action(); if (value) return value; await pause(100) }
  throw new Error(message)
}
async function launch(executable, env) {
  const child = spawn(executable, ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', debuggerURL, error
  const exit = new Promise((resolve) => child.once('exit', (code) => resolve(code)))
  child.on('error', (value) => { error = value })
  child.stdout.on('data', (data) => { output = (output + data).slice(-20000) })
  child.stderr.on('data', (data) => { output = (output + data).slice(-20000); debuggerURL ||= output.match(/DevTools listening on (ws:\/\/\S+)/)?.[1] })
  try {
    await until(() => { if (error) throw error; if (child.exitCode !== null || child.signalCode !== null) throw new Error(output); return debuggerURL }, 'No desktop debugger', 60000)
    const targetsURL = debuggerURL.replace('ws:', 'http:').replace(/\/devtools\/browser\/.*/, '/json/list')
    const target = await until(async () => (await (await fetch(targetsURL, { signal: AbortSignal.timeout(5000) })).json())
      .find((target) => target.type === 'page' && target.url === 'pdfer://app/'), 'No desktop window', 60000)
    const client = await connect(target.webSocketDebuggerUrl)
    const evaluate = async (expression) => {
      const response = await client.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails))
      return response.result.value
    }
    await until(async () => {
      try { return await evaluate("location.href === 'pdfer://app/' && document.readyState === 'complete' && !!window.pdferDesktop && !!document.querySelector('#panel-merge')") }
      catch (error) { if (!/context was destroyed|Cannot find context/.test(error.message)) throw error }
    }, 'UI did not finish loading')
    const state = () => evaluate('window.pdferDesktop.getUpdateState()')
    const waitState = (status, timeout = 30000) => until(async () => {
      const value = await state()
      if (value.status === status) return value
      if (value.status === 'error' && status !== 'error') throw new Error(JSON.stringify(value))
    }, `Expected update state ${status}`, timeout)
    return { child, exit, client, evaluate, state, waitState }
  } catch (error) { child.kill('SIGKILL'); throw error }
}
async function close(instance) {
  try { await instance.client.call('Page.close') }
  catch (error) { if (!/context was destroyed|debugger disconnected|Target closed|Session closed/.test(error.message)) throw error }
  assert.equal(await Promise.race([instance.exit, pause(30000).then(() => 'timeout')]), 0, 'Desktop did not close cleanly')
  instance.client.socket.close()
}
function fixturePids(executable) {
  const expression = executable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  try { return execFileSync('pgrep', ['-f', `^${expression}( |$)`], { encoding: 'utf8' }).trim().split('\n').map(Number).filter((pid) => Number.isSafeInteger(pid) && pid > 1) }
  catch { return [] }
}

async function run() {
  assert.equal(process.platform, 'darwin', 'Sparkle integration tests run on macOS.')
  const directory = await fsp.mkdtemp(path.join(root, 'desktop/build/sparkle-test-'))
  const suffix = path.basename(directory), profileName = `pdfer-${suffix}`, appId = `com.pdfer.${suffix}`
  const profile = path.join(os.homedir(), 'Library/Application Support', profileName)
  assert.equal(fs.existsSync(profile), false)
  const seed = crypto.randomBytes(32).toString('base64'), publicKey = publicKeyFromSeed(seed)
  let feed = '', archive, mode = 'valid', archiveRequests = 0, instance, executable, succeeded = false
  const server = http.createServer((request, response) => {
    if (request.url === '/feed.xml') {
      response.writeHead(200, { 'Content-Type': 'application/xml', 'Cache-Control': 'no-store' })
      response.end(mode === 'bad-feed' ? feed.replace('pdfer updates', 'tampered feed') : feed)
    } else if (request.url === '/update.zip') {
      archiveRequests++
      response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': fs.statSync(archive).size })
      const stream = fs.createReadStream(archive)
      if (mode === 'bad-archive') {
        let first = true
        stream.on('data', (chunk) => { if (first) { chunk[0] ^= 1; first = false }; response.write(chunk) })
        stream.on('end', () => response.end())
      } else stream.pipe(response)
      response.on('close', () => stream.destroy())
    } else { response.writeHead(404); response.end() }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const env = { ...process.env, PDFER_RELEASE: '0', PDFER_RELEASE_REPOSITORY: '', SPARKLE_PUBLIC_KEY: publicKey,
    PDFER_SPARKLE_FEED_URL: `${origin}/feed.xml`, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
  for (const key of ['CSC_LINK', 'WIN_CSC_LINK', 'MAC_CSC_LINK', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER', 'SPARKLE_PRIVATE_KEY', 'PDFER_USER_DATA_DIR', 'PDFER_REQUIRE_OS_SIGNING']) delete env[key]
  const configFile = path.join(directory, 'electron-builder.cjs')
  fs.writeFileSync(configFile, `const config = require(${JSON.stringify(path.join(root, 'desktop/electron-builder.cjs'))});\nmodule.exports = { ...config, appId: ${JSON.stringify(appId)}, extraMetadata: {version: process.env.PDFER_BUILD_VERSION, name:${JSON.stringify(profileName)}, productName:${JSON.stringify(profileName)} } };\n`)
  const build = (version, label) => {
    const output = path.join(directory, label)
    execFileSync('pnpm', ['exec', 'electron-builder', '--config', configFile, '--dir', '--publish', 'never'], {
      cwd: root, env: { ...env, PDFER_BUILD_VERSION: version, PDFER_OUTPUT_DIR: output }, stdio: 'inherit',
    })
    return path.join(output, `mac${process.arch === 'x64' ? '' : '-' + process.arch}`, 'pdfer.app')
  }
  try {
    const original = build('0.1.0', 'old'), update = build('0.1.1', 'new')
    const installed = path.join(directory, 'installed/pdfer.app')
    await fsp.mkdir(path.dirname(installed), { recursive: true })
    execFileSync('/usr/bin/ditto', [original, installed])
    archive = path.join(directory, 'update.zip')
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', update, archive])
    const appcastFile = path.join(directory, 'feed.xml')
    signAppcast({ archive, output: appcastFile, version: '0.1.1', url: `${origin}/update.zip`, seed, publicKey })
    feed = fs.readFileSync(appcastFile, 'utf8')
    executable = path.join(installed, 'Contents/MacOS/pdfer')
    instance = await launch(executable, env)
    assert.equal(fs.existsSync(path.join(profile, 'desktop.log')), true, 'Fixture must use its isolated profile')
    assert.equal((await instance.state()).currentVersion, '0.1.0')
    mode = 'bad-feed'
    await instance.evaluate('window.pdferDesktop.checkForUpdates()'); await instance.waitState('error')
    assert.equal(archiveRequests, 0, 'A tampered feed must not trigger a download')
    console.log('Sparkle rejected a tampered signed feed.')
    mode = 'bad-archive'
    await instance.evaluate('window.pdferDesktop.checkForUpdates()'); await instance.waitState('available')
    await instance.evaluate('window.pdferDesktop.downloadUpdate()'); await instance.waitState('error', 60000)
    console.log('Sparkle rejected an archive with an invalid signature.')
    mode = 'valid'
    await instance.evaluate('window.pdferDesktop.checkForUpdates()'); await instance.waitState('available')
    await instance.evaluate('window.pdferDesktop.downloadUpdate()'); await instance.waitState('downloaded', 60000)
    await instance.evaluate("localStorage.setItem('sparkle-update-test', 'preserved')")
    await close(instance)
    const versionOf = () => execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.join(installed, 'Contents/Info.plist')], { encoding: 'utf8' }).trim()
    assert.equal(versionOf(), '0.1.0', 'An ordinary quit must cancel the pending install')
    console.log('Ordinary quit cancelled the staged update.')
    instance = await launch(executable, env)
    assert.equal(await instance.evaluate("localStorage.getItem('sparkle-update-test')"), 'preserved')
    await instance.evaluate('window.pdferDesktop.checkForUpdates()'); await instance.waitState('available')
    await instance.evaluate('window.pdferDesktop.downloadUpdate()'); await instance.waitState('downloaded', 60000)
    try { await instance.evaluate('window.pdferDesktop.installUpdate()') }
    catch (error) { if (!/context was destroyed|debugger disconnected/.test(error.message)) throw error }
    assert.equal(await Promise.race([instance.exit, pause(30000).then(() => 'timeout')]), 0, 'Old app must exit for Sparkle')
    instance.client.socket.close()
    await until(() => versionOf() === '0.1.1', 'Sparkle did not replace the app', 60000)
    await until(() => fs.readFileSync(path.join(profile, 'desktop.log'), 'utf8').includes('pdfer 0.1.1 ready'), 'Sparkle did not relaunch the new app', 30000)
    console.log('Sparkle replaced and relaunched the ad-hoc-signed app: 0.1.0 → 0.1.1.')
    for (const pid of fixturePids(executable)) process.kill(pid, 'SIGTERM')
    await until(() => fixturePids(executable).length === 0, 'Relaunched fixture did not exit')
    instance = await launch(executable, env)
    assert.equal((await instance.state()).currentVersion, '0.1.1')
    assert.equal(await instance.evaluate("localStorage.getItem('sparkle-update-test')"), 'preserved')
    await close(instance)
    console.log('Updated app retained its local profile.')
    succeeded = true
  } catch (error) {
    if (fs.existsSync(path.join(profile, 'desktop.log'))) console.error(fs.readFileSync(path.join(profile, 'desktop.log'), 'utf8').slice(-6000))
    console.error(`Retained fixture for inspection: ${directory}`)
    throw error
  } finally {
    if (instance && instance.child.exitCode === null && instance.child.signalCode === null) instance.child.kill('SIGKILL')
    instance?.client.socket.close()
    if (executable) {
      // Sparkle relaunches through LaunchServices; the new app isn't our child.
      for (const pid of fixturePids(executable)) { try { process.kill(pid, 'SIGTERM') } catch { /* Already closed. */ } }
    }
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve))
    await pause(1000)
    await fsp.rm(profile, { recursive: true, force: true })
    await fsp.rm(path.join(os.homedir(), 'Library/Caches', appId), { recursive: true, force: true })
    try { execFileSync('/usr/bin/defaults', ['delete', appId], { stdio: 'ignore' }) } catch { /* No preferences yet. */ }
    if (succeeded) await fsp.rm(directory, { recursive: true, force: true })
  }
}

run().then(() => process.exit(0), (error) => { console.error(error); process.exit(1) })
