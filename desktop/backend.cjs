const { randomBytes } = require('node:crypto')
const { createInterface } = require('node:readline')
const { spawnLocal, stopProcess } = require('./process.cjs')

async function startBackend({ command, args = [], env = {}, cwd, log = () => {}, onExit = () => {} }) {
  const token = randomBytes(32).toString('hex')
  const child = spawnLocal(command, args, { cwd, env: { ...process.env, ...env, PDFER_DESKTOP_TOKEN: token,
    PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1' } })
  let stopping = false
  let ready = false
  const stop = async () => { stopping = true; await stopProcess(child) }
  child.stdin.on('error', () => {})
  child.stderr.on('data', (data) => log(data.toString()))
  child.on('exit', (code) => { if (ready && !stopping) onExit(code) })
  try {
    const port = await new Promise((resolve, reject) => {
      const lines = createInterface({ input: child.stdout })
      const timeout = setTimeout(() => fail(new Error('The local PDF engine took too long to start.')), 60000)
      const cleanup = () => {
        clearTimeout(timeout); lines.close()
        child.removeListener('error', fail); child.removeListener('exit', earlyExit)
      }
      const fail = (error) => { cleanup(); reject(error) }
      const earlyExit = () => fail(new Error('The local PDF engine could not start.'))
      child.once('error', fail)
      child.once('exit', earlyExit)
      lines.on('line', (line) => {
        try {
          const value = JSON.parse(line)
          if (value.pdfer === 'ready' && Number.isInteger(value.port) && value.port > 0 && value.port <= 65535) {
            cleanup(); resolve(value.port)
          }
        } catch { /* Ignore non-protocol output from native dependencies. */ }
      })
    })
    const url = `http://127.0.0.1:${port}`
    const response = await fetch(`${url}/api/desktop/health`, {
      headers: { 'x-pdfer-token': token }, signal: AbortSignal.timeout(5000), redirect: 'error',
    })
    if (!response.ok || !(await response.json()).ready) throw new Error('The local PDF engine did not respond.')
    ready = true
    // Continue draining output after the readiness handshake.
    child.stdout.on('data', () => {})
    return { url, token, stop, child }
  } catch (error) { await stop(); throw error }
}

module.exports = { startBackend }
