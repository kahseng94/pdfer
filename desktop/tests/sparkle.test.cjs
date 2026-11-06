const { test } = require('node:test')
const assert = require('node:assert/strict')
const { SparkleUpdater } = require('../sparkle.cjs')
const { Updates } = require('../updates.cjs')

function fixture(options = {}) {
  let callback
  const calls = []
  const native = { start: (cb) => { callback = cb }, check: () => calls.push('check'), download: () => calls.push('download'),
    install: () => calls.push('install'), stop: () => calls.push('stop') }
  const updater = new SparkleUpdater(native, options)
  const controller = new Updates(updater, { enabled: true, version: '0.1.0' })
  const send = (event, values = {}) => callback(JSON.stringify({ event, ...values }))
  send('ready')
  return { updater, controller, calls, send }
}

test('Sparkle download and installation require separate user actions', async () => {
  const { updater, controller, calls, send } = fixture()
  await controller.check(); await controller.check()
  assert.deepEqual(calls, ['check'])
  send('available', { version: '0.2.0' })
  assert.equal(controller.state.status, 'available')
  await controller.download()
  send('progress', { percent: 60 })
  assert.equal(controller.state.percent, 60)
  send('downloaded', { version: '0.2.0' })
  assert.deepEqual(calls, ['check', 'download'])
  updater.quitAndInstall()
  assert.deepEqual(calls, ['check', 'download', 'install'])
})
test('signature failures require a fresh check and never become installable', async () => {
  const { controller, calls, send } = fixture()
  await controller.check(); send('available', { version: '0.2.0' }); await controller.download()
  send('error', { message: 'Signature verification failed' })
  assert.equal(controller.state.status, 'error')
  assert.ok(!calls.includes('install'))
  await controller.check()
  assert.equal(calls.at(-1), 'check')
  send('downloaded', { version: '0.2.0' })
  send('error', { message: 'The staged installation was aborted' })
  assert.equal(controller.state.status, 'error')
})
test('ordinary quit waits for Sparkle to cancel its staged installation', async () => {
  const { updater, calls, send } = fixture()
  send('downloaded', { version: '0.2.0' })
  let completed = false
  const stopped = updater.dispose().then(() => { completed = true })
  await Promise.resolve()
  assert.equal(completed, false)
  assert.equal(calls.at(-1), 'stop')
  send('stopped')
  await stopped
  assert.equal(completed, true)
  assert.ok(!calls.includes('install'))
})

test('shows a retryable first-release status after a confirmed missing feed', async () => {
  let missing = true
  const { controller, send, calls } = fixture({ feedURL: 'https://github.com/example/pdfer/releases/latest/download/appcast-arm64.xml', releaseLookup: async () => missing })
  await controller.check()
  assert.deepEqual(calls, [])
  assert.equal(controller.state.status, 'idle')
  assert.equal(controller.state.message, 'No published stable release is available yet.')
  missing = false
  await controller.check()
  assert.deepEqual(calls, ['check'])
  send('available', { version: '0.2.0' })
  assert.equal(controller.state.status, 'available')
})

test('never hides signature failures behind the first-release diagnostic', async () => {
  let lookups = 0
  const { controller, send } = fixture({ feedURL: 'https://github.com/example/pdfer/releases/latest/download/appcast-arm64.xml', releaseLookup: async () => { lookups++; return false } })
  await controller.check()
  send('error', { message: 'Bad signature', feedRetrievalFailed: true, signatureFailure: true })
  assert.equal(controller.state.status, 'error')
  assert.equal(lookups, 1)
})

test('a late release diagnostic cannot replace a verified downloaded update', async () => {
  let finish
  const { controller, send } = fixture({ feedURL: 'https://github.com/example/pdfer/releases/latest/download/appcast-arm64.xml',
    releaseLookup: () => new Promise((resolve) => { finish = resolve }) })
  const checking = controller.check()
  await new Promise(setImmediate)
  send('downloaded', { version: '0.2.0' })
  finish(true)
  await checking
  assert.equal(controller.state.status, 'downloaded')
})
