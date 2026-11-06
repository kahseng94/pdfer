const path = require('node:path')
const { createHash } = require('node:crypto')
const { readFileSync, existsSync } = require('node:fs')
const { mkdir, copyFile } = require('node:fs/promises')
const { spawnLocal, stopProcess } = require('./process.cjs')

class OcrSetup {
  constructor({ source, dataDir, uv, notify = () => {}, log = () => {} }) {
    this.source = source
    this.uv = uv
    this.notify = notify
    this.log = log
    const key = createHash('sha256').update(readFileSync(path.join(source, 'uv.lock'))).digest('hex').slice(0, 16)
    this.runtime = path.join(dataDir, 'ocr', key)
    this.models = path.join(dataDir, 'ocr', 'models')
    this.env = { ...process.env, UV_CACHE_DIR: path.join(dataDir, 'ocr', 'cache'),
      UV_PYTHON_INSTALL_DIR: path.join(dataDir, 'ocr', 'python'), UV_PYTHON_PREFERENCE: 'only-managed',
      PDFER_PADDLE_MODELS: this.models, HF_HOME: path.join(dataDir, 'ocr', 'huggingface'),
      PADDLE_PDX_CACHE_HOME: path.join(dataDir, 'ocr', 'paddle-cache'),
      PDFER_OCR_SETUP_HELP: 'Use Install PaddleOCR in the desktop app, then check again.' }
    const supported = (process.platform === 'darwin' && process.arch === 'arm64') ||
      (['linux', 'win32'].includes(process.platform) && process.arch === 'x64')
    const installed = existsSync(this.pythonPath()) && existsSync(path.join(this.models, 'manifest.json'))
    this.state = { status: supported ? installed ? 'ready' : 'idle' : 'unsupported' }
    this.child = null
    this.stopping = false
  }
  pythonPath() { return path.join(this.runtime, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python') }
  backendEnv() { return { PDFER_PADDLE_RUNTIME: this.runtime, PDFER_PADDLE_PYTHON: this.pythonPath(),
    PDFER_PADDLE_MODELS: this.models, PDFER_OCR_SETUP_HELP: this.env.PDFER_OCR_SETUP_HELP,
    PADDLE_PDX_CACHE_HOME: this.env.PADDLE_PDX_CACHE_HOME } }
  set(change) { this.state = { ...this.state, ...change }; this.notify(this.state) }
  run(args) {
    return new Promise((resolve, reject) => {
      const child = this.child = spawnLocal(this.uv, args, { env: this.env, cwd: this.runtime })
      child.stdin.on('error', () => {})
      child.stdout.on('data', (data) => this.log(data.toString()))
      child.stderr.on('data', (data) => this.log(data.toString()))
      child.once('error', reject)
      child.once('close', (code) => { this.child = null; code === 0 ? resolve() : reject(new Error('OCR setup failed')) })
    })
  }
  async install() {
    if (this.stopping || ['installing', 'unsupported'].includes(this.state.status)) return this.state
    this.set({ status: 'installing', message: 'Downloading the local OCR runtime…' })
    try {
      await mkdir(this.runtime, { recursive: true })
      for (const name of ['pyproject.toml', 'uv.lock', 'worker.py', 'setup_models.py']) {
        await copyFile(path.join(this.source, name), path.join(this.runtime, name))
      }
      await this.run(['sync', '--project', this.runtime, '--frozen', '--no-dev', '--python', '3.12'])
      if (this.stopping) return this.state
      this.set({ message: 'Downloading models and checking local recognition…' })
      await this.run(['run', '--project', this.runtime, '--frozen', '--no-sync', 'python', path.join(this.runtime, 'setup_models.py')])
      this.set({ status: 'ready', message: 'PaddleOCR is ready to use offline.' })
    } catch {
      this.set({ status: 'error', message: 'Could not install PaddleOCR. Check your connection and try again.' })
    }
    return this.state
  }
  async stop() { this.stopping = true; await stopProcess(this.child) }
}

module.exports = { OcrSetup }
