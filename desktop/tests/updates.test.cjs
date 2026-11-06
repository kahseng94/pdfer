const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { Updates } = require('../updates.cjs')

function fixture(enabled = true) {
  const updater = new EventEmitter()
  updater.checkForUpdates = async () => updater.emit('update-available', { version: '0.2.0' })
  updater.downloadUpdate = async () => updater.emit('update-downloaded', { version: '0.2.0' })
  const controller = new Updates(updater, { enabled, version: '0.1.0' })
  return { updater, controller }
}

test('updates require an explicit download and never install on ordinary quit', async () => {
  const { controller, updater } = fixture()
  assert.equal(updater.autoDownload, false)
  assert.equal(updater.autoInstallOnAppQuit, false)
  assert.equal(updater.allowDowngrade, false)
  await controller.check()
  assert.equal(controller.state.status, 'available')
  await controller.download()
  assert.equal(controller.state.status, 'downloaded')
  await controller.check()
  updater.emit('error', new Error('offline'))
  assert.equal(controller.state.status, 'downloaded')
})

test('offline checks and failed downloads can be retried', async () => {
  const { controller, updater } = fixture()
  updater.checkForUpdates = async () => { throw new Error('offline') }
  await controller.check()
  assert.equal(controller.state.status, 'error')
  updater.checkForUpdates = async () => updater.emit('update-available', { version: '0.2.0' })
  await controller.check()
  updater.downloadUpdate = async () => { throw new Error('offline') }
  await controller.download()
  assert.equal(controller.state.status, 'available')
  assert.match(controller.state.message, /connection/)
  updater.downloadUpdate = async () => updater.emit('update-downloaded', { version: '0.2.0' })
  await controller.download()
  assert.equal(controller.state.status, 'downloaded')
})

test('duplicate requests and unconfigured builds do not contact the updater', async () => {
  const { controller, updater } = fixture()
  let finish, calls = 0
  updater.checkForUpdates = () => { calls++; return new Promise((resolve) => { finish = resolve }) }
  const first = controller.check()
  await controller.check()
  assert.equal(calls, 1)
  finish(); await first
  const disabled = fixture(false)
  disabled.updater.checkForUpdates = () => assert.fail('Disabled updater made a request')
  await disabled.controller.check()
  assert.equal(disabled.controller.state.status, 'disabled')
})
