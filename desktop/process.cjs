const { spawn } = require('node:child_process')
const path = require('node:path')

function spawnLocal(command, args, options = {}) {
  return spawn(command, args, { ...options, shell: false, windowsHide: true,
    detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
}

async function stopProcess(child) {
  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.stdin.on('error', () => {})
  child.stdin.end()
  const timer = setTimeout(() => {
    if (!child.pid) return
    if (process.platform === 'win32') {
      const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      killer.on('error', () => child.kill())
    } else {
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* Already exited. */ }
    }
  }, 3500)
  try { await exited } finally { clearTimeout(timer) }
}

module.exports = { spawnLocal, stopProcess }
