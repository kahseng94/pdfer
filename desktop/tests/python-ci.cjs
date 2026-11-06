// Keep native-code hangs from trapping CI's inherited output pipes. Stream a
// separate log and terminate the complete test process tree on a hard deadline.
const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const { StringDecoder } = require('node:string_decoder')

const directory = path.resolve(__dirname, '../build')
fs.mkdirSync(directory, { recursive: true })
const file = path.join(directory, 'python-tests.log')
const output = fs.openSync(file, 'w+')
const reader = fs.openSync(file, 'r')
const decoder = new StringDecoder('utf8')
let offset = 0, finished = false
const child = spawn('uv', ['--directory', 'backend', 'run', 'pytest', '-x', process.platform === 'win32' ? '-vv' : '-q',
  '--timeout=120', '--timeout-method=thread', '-o', 'faulthandler_timeout=90'], {
  cwd: path.resolve(__dirname, '../..'), env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
  detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', output, output],
})
function flush() {
  const size = fs.fstatSync(reader).size
  if (size <= offset) return
  const data = Buffer.alloc(size - offset)
  const count = fs.readSync(reader, data, 0, data.length, offset)
  offset += count
  process.stdout.write(decoder.write(data.subarray(0, count)))
}
function stop() {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    const result = spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'], { timeout: 15000, windowsHide: true, encoding: 'utf8' })
    if (result.error) console.error(result.error.message)
  } else { try { process.kill(-child.pid, 'SIGKILL') } catch { /* Already stopped. */ } }
}
function finish(code) {
  if (finished) return
  finished = true
  clearInterval(poll); clearTimeout(deadline)
  flush(); fs.closeSync(output); fs.closeSync(reader)
  process.stdout.write(decoder.end(), () => process.exit(code))
}
const poll = setInterval(flush, 1000)
const deadline = setTimeout(() => {
  console.error('Python tests exceeded the 6-minute process deadline. Stopping the test tree; see the captured traceback below.')
  stop(); finish(1)
}, 6 * 60 * 1000)
child.on('error', (error) => { console.error(error.message); finish(1) })
child.on('exit', (code) => finish(code ?? 1))
process.on('SIGTERM', () => { stop(); finish(1) })
process.on('SIGINT', () => { stop(); finish(1) })
