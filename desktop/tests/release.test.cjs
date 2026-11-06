const { test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { releaseSettings, normalizeSigningEnvironment } = require('../release-config.cjs')
const { generate, publicKeyFromSeed, privateKeyFromSeed } = require('../sparkle/keys.cjs')
const { appcast } = require('../sparkle/publish.cjs')

const seed = Buffer.alloc(32, 7).toString('base64')
const publicKey = publicKeyFromSeed(seed)
const releaseEnv = { PDFER_RELEASE: '1', GITHUB_REPOSITORY: 'example/pdfer' }

test('unset CI certificate secrets are absent instead of empty file paths', () => {
  const env = { ...releaseEnv, CSC_LINK: '', WIN_CSC_LINK: '', MAC_CSC_LINK: '', CSC_KEY_PASSWORD: '' }
  normalizeSigningEnvironment(env)
  assert.equal('CSC_LINK' in env, false)
  assert.equal('WIN_CSC_LINK' in env, false)
  assert.equal('MAC_CSC_LINK' in env, false)
  assert.equal(releaseSettings({ env, platform: 'darwin', publicKey }).osSigning, false)
  const supplied = { CSC_LINK: 'certificate.p12', CSC_KEY_PASSWORD: ' password ' }
  normalizeSigningEnvironment(supplied)
  assert.equal(supplied.CSC_LINK, 'certificate.p12')
  assert.equal(supplied.CSC_KEY_PASSWORD, ' password ')
})

test('unsigned Windows releases retain NSIS update publishing', () => {
  const config = releaseSettings({ env: releaseEnv, platform: 'win32', arch: 'x64', publicKey })
  assert.equal(config.osSigning, false)
  assert.equal(config.forceCodeSigning, false)
  assert.equal(config.publish[0].provider, 'github')
  assert.equal(config.publish[0].channel, 'latest-x64')
})
test('Windows signing remains available and explicitly required signing fails closed', () => {
  const config = releaseSettings({ env: { ...releaseEnv, WIN_CSC_LINK: 'certificate' }, platform: 'win32', publicKey })
  assert.equal(config.osSigning, true)
  assert.equal(config.forceCodeSigning, true)
  assert.throws(() => releaseSettings({ env: { ...releaseEnv, PDFER_REQUIRE_OS_SIGNING: '1' }, platform: 'win32', publicKey }), /no certificate/)
})
test('Mac releases require the free update key, not Apple certificates', () => {
  const config = releaseSettings({ env: releaseEnv, platform: 'darwin', arch: 'arm64', publicKey })
  assert.equal(config.sparkleEnabled, true)
  assert.equal(config.notarize, false)
  assert.equal(config.forceCodeSigning, false)
  assert.equal(config.feedURL, 'https://github.com/example/pdfer/releases/latest/download/appcast-arm64.xml')
  assert.throws(() => releaseSettings({ env: releaseEnv, platform: 'darwin', publicKey: null }), /free Sparkle key/)
})
test('production feeds reject insecure URLs, while loopback fixtures can be tested', () => {
  for (const url of ['http://example.com/feed.xml', 'https://user:password@example.com/feed.xml', 'file:///tmp/feed.xml']) {
    assert.throws(() => releaseSettings({ env: { ...releaseEnv, PDFER_SPARKLE_FEED_URL: url }, platform: 'darwin', publicKey }))
  }
  assert.equal(releaseSettings({ env: { PDFER_SPARKLE_FEED_URL: 'http://127.0.0.1:1234/feed.xml' }, platform: 'darwin', publicKey }).sparkleEnabled, true)
})
test('generated update identities are stable, restricted, and cannot be overwritten', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfer-signing-test-'))
  try {
    const privateFile = path.join(directory, 'secret'), publicFile = path.join(directory, 'public.json')
    const result = generate(privateFile, publicFile)
    const seed = fs.readFileSync(privateFile, 'utf8')
    assert.equal(publicKeyFromSeed(seed), result.publicKey)
    if (process.platform !== 'win32') assert.equal(fs.statSync(privateFile).mode & 0o777, 0o600)
    assert.throws(() => generate(privateFile, publicFile), /already exist/)
    assert.throws(() => privateKeyFromSeed('not a key'))
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})
test('appcast binds version, download URL and archive signature', () => {
  const signature = crypto.sign(null, Buffer.from('archive'), privateKeyFromSeed(seed)).toString('base64')
  const xml = appcast({ version: '0.2.0', url: 'https://example.com/update.zip?one=1&two=2', signature, length: 1234 })
  assert.match(xml, /<sparkle:version>0.2.0<\/sparkle:version>/)
  assert.ok(xml.includes(`sparkle:edSignature="${signature}"`))
  assert.ok(xml.includes('one=1&amp;two=2'))
  assert.throws(() => appcast({ version: 'bad', url: 'x', signature, length: 1 }))
})
