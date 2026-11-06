const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtemp, rm } = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { once } = require('node:events')
const { startBackend } = require('../backend.cjs')

test('desktop server authenticates requests and exits when its parent pipe closes', { timeout: 20000 }, async () => {
  const root = path.resolve(__dirname, '../..')
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'pdfer-backend-'))
  let backend
  try {
    backend = await startBackend({ command: path.join(root, 'backend/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
      args: ['-m', 'pdfer.desktop'], env: { PDFER_DATA_DIR: dataDir }, cwd: root })
    assert.equal((await fetch(`${backend.url}/api/signatures`)).status, 403)
    const headers = { 'x-pdfer-token': backend.token }
    assert.equal((await fetch(`${backend.url}/api/signatures`, { headers })).status, 200)
    assert.equal((await fetch(`${backend.url}/api/signatures`, { headers: { ...headers, origin: 'https://example.com' } })).status, 403)
    const closed = once(backend.child, 'exit')
    backend.child.stdin.end()
    await closed
    assert.equal(backend.child.exitCode, 0)
  } finally { await backend?.stop(); await rm(dataDir, { recursive: true, force: true }) }
})

test('missing backend executables fail without hanging', { timeout: 5000 }, async () => {
  await assert.rejects(startBackend({ command: path.join(os.tmpdir(), 'pdfer-not-an-executable') }))
})
