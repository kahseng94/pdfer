const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtemp, writeFile, rm } = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { createHandler, isAppURL } = require('../protocol.cjs')

test('only the exact app host is trusted', () => {
  for (const url of ['pdfer://app/', 'pdfer://app/api/merge']) assert.equal(isAppURL(url), true)
  for (const url of ['https://app/', 'pdfer://app.evil/', 'pdfer://user@app/', 'pdfer://app:80/', 'file:///tmp/file']) assert.equal(isAppURL(url), false)
})

test('serves packaged assets with CSP and blocks escaped paths', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pdfer-protocol-'))
  try {
    await writeFile(path.join(root, 'index.html'), '<h1>pdfer</h1>')
    const handle = createHandler(root, { url: 'http://127.0.0.1:1', token: 'private' })
    const response = await handle(new Request('pdfer://app/'))
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-security-policy'), /object-src 'none'/)
    assert.match(await response.text(), /pdfer/)
    assert.equal((await handle(new Request('pdfer://app/%2e%2e%2fsecret'))).status, 403)
    assert.equal((await handle(new Request('pdfer://evil/'))).status, 404)
    assert.equal((await handle(new Request('pdfer://app/missing.js'))).status, 404)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('forwards multipart bytes privately, preserves download headers, and handles unavailable backends', async () => {
  let received
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    received = { headers: req.headers, body: Buffer.concat(chunks).toString() }
    res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="output.pdf"' })
    res.end('%PDF-test')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  const handle = createHandler(os.tmpdir(), { url, token: 'private-session-token' })
  try {
    const body = new FormData()
    body.append('file', new Blob(['local document']), 'input.pdf')
    const response = await handle(new Request('pdfer://app/api/merge', { method: 'POST', body,
      headers: { origin: 'https://evil.example', 'x-pdfer-token': 'forged' } }))
    assert.equal(await response.text(), '%PDF-test')
    assert.match(response.headers.get('content-disposition'), /output.pdf/)
    assert.equal(received.headers['x-pdfer-token'], 'private-session-token')
    assert.equal(received.headers.origin, url)
    assert.match(received.body, /local document/)
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) }
  assert.equal((await handle(new Request('pdfer://app/api/fonts'))).status, 503)
})
