const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtemp, rm } = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

test('importing the package entry starts pdfer with its profile lock', async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'pdfer-start-'))
  const oldProfile = process.env.PDFER_USER_DATA_DIR
  process.env.PDFER_USER_DATA_DIR = profile
  const electron = require.resolve('electron')
  const cached = require.cache[electron]
  t.after(async () => {
    if (cached) require.cache[electron] = cached
    else delete require.cache[electron]
    if (oldProfile === undefined) delete process.env.PDFER_USER_DATA_DIR
    else process.env.PDFER_USER_DATA_DIR = oldProfile
    await rm(profile, { recursive: true, force: true })
  })

  let userData, locked = false
  const app = {
    setPath(name, value) { if (name === 'userData') userData = value },
    requestSingleInstanceLock() { assert.equal(userData, profile); locked = true; return true },
    // Stop at native readiness so this regression runs on headless CI as well.
    whenReady: t.mock.fn(() => { assert.ok(locked); return new Promise(() => {}) }),
  }
  require.cache[electron] = { loaded: true, exports: { app, protocol: { registerSchemesAsPrivileged() {} } } }

  // Electron's development loader uses import() even for a CommonJS package entry.
  await import(pathToFileURL(require.resolve('../..')).href)
  assert.equal(app.whenReady.mock.callCount(), 1)
})
