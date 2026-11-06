const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const publicKeyFile = path.join(__dirname, 'public-key.json')
const defaultPrivateKeyFile = path.join(os.homedir(), '.config', 'pdfer-signing', 'sparkle-private-key')
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

function privateKeyFromSeed(seed) {
  const bytes = Buffer.from(seed.trim(), 'base64')
  if (bytes.length !== 32 || bytes.toString('base64') !== seed.trim()) throw new Error('Expected a base64 Sparkle Ed25519 seed (32 bytes).')
  return crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, bytes]), format: 'der', type: 'pkcs8' })
}
function publicKeyFromSeed(seed) {
  return crypto.createPublicKey(privateKeyFromSeed(seed)).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64')
}
function readPublicKey(env = process.env) {
  let key = env.SPARKLE_PUBLIC_KEY
  if (!key && fs.existsSync(publicKeyFile)) key = JSON.parse(fs.readFileSync(publicKeyFile, 'utf8')).publicKey
  if (!key) return null
  key = key.trim()
  if (Buffer.from(key, 'base64').length !== 32 || Buffer.from(key, 'base64').toString('base64') !== key) throw new Error('Invalid Sparkle public key.')
  return key
}
function readPrivateSeed(env = process.env) {
  let seed = env.SPARKLE_PRIVATE_KEY
  if (!seed) {
    try { seed = fs.readFileSync(env.SPARKLE_PRIVATE_KEY_FILE || defaultPrivateKeyFile, 'utf8') }
    catch { throw new Error('Set the SPARKLE_PRIVATE_KEY Actions secret, or restore the local Sparkle private-key file.') }
  }
  privateKeyFromSeed(seed)
  return seed.trim()
}
function generate(privateFile = defaultPrivateKeyFile, publicFile = publicKeyFile) {
  // Never replace an existing signing identity. It is needed by installed apps.
  if (fs.existsSync(privateFile) || fs.existsSync(publicFile)) throw new Error('Signing keys already exist. Reuse and back them up; do not generate a new identity for an update.')
  const seed = crypto.randomBytes(32).toString('base64')
  const publicKey = publicKeyFromSeed(seed)
  fs.mkdirSync(path.dirname(privateFile), { recursive: true, mode: 0o700 })
  fs.writeFileSync(privateFile, seed + '\n', { mode: 0o600, flag: 'wx' })
  fs.mkdirSync(path.dirname(publicFile), { recursive: true })
  fs.writeFileSync(publicFile, JSON.stringify({ publicKey }, null, 2) + '\n', { flag: 'wx' })
  return { privateFile, publicFile, publicKey }
}

module.exports = { readPublicKey, readPrivateSeed, privateKeyFromSeed, publicKeyFromSeed, generate, defaultPrivateKeyFile }
if (require.main === module) {
  try {
    const result = generate()
    console.log(`Public key saved in ${result.publicFile}\nPrivate key saved outside the repository in ${result.privateFile}\nBack up the private key and add its contents to the SPARKLE_PRIVATE_KEY GitHub Actions secret.`)
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
