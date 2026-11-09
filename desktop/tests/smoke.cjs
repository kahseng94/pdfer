// Exercise the actual packaged executable using a temporary local debugger.
// No test-only bridge or test code is shipped inside the application.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { spawn } = require('node:child_process')
const { samplePdf } = require('./fixture.cjs')

const root = path.resolve(__dirname, '../..')
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
function applicationPath() {
  if (process.env.PDFER_SMOKE_APP) return process.env.PDFER_SMOKE_APP
  if (process.platform === 'darwin') return path.join(root, `release/mac${process.arch === 'x64' ? '' : '-' + process.arch}/pdfer.app/Contents/MacOS/pdfer`)
  if (process.platform === 'win32') return path.join(root, 'release/win-unpacked/pdfer.exe')
  return path.join(root, 'release/linux-unpacked/pdfer')
}
async function connect(url) {
  const socket = new WebSocket(url)
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  let id = 0
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data), call = pending.get(message.id)
    if (call) { pending.delete(message.id); message.error ? call.reject(new Error(message.error.message)) : call.resolve(message.result) }
  })
  socket.addEventListener('close', () => {
    for (const call of pending.values()) call.reject(new Error('The test debugger disconnected.'))
    pending.clear()
  })
  return { socket, call: (method, params = {}) => new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }))
  }) }
}

async function run(dataDir, phase) {
  const child = spawn(applicationPath(), ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'], {
    env: { ...process.env, PDFER_USER_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exit = new Promise((resolve) => child.once('exit', (code) => resolve(code)))
  let output = '', debuggerUrl, spawnError, connection
  child.on('error', (error) => { spawnError = error })
  child.stdout.on('data', (data) => { output = (output + data).slice(-20000) })
  child.stderr.on('data', (data) => {
    output = (output + data).slice(-20000)
    debuggerUrl ||= output.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1]
  })
  try {
    const deadline = Date.now() + 60000
    while (!debuggerUrl && Date.now() < deadline) { if (spawnError) throw spawnError; if (child.exitCode !== null) throw new Error(output); await pause(100) }
    assert.ok(debuggerUrl, `Desktop app did not start: ${output}`)
    let target
    const httpUrl = debuggerUrl.replace('ws:', 'http:').replace(/\/devtools\/browser\/.*/, '/json/list')
    while (!target && Date.now() < deadline) {
      const targets = await (await fetch(httpUrl, { signal: AbortSignal.timeout(5000) })).json()
      target = targets.find((item) => item.type === 'page' && item.url === 'pdfer://app/')
      if (!target) await pause(100)
    }
    assert.ok(target, `Desktop window did not load: ${output}`)
    connection = await connect(target.webSocketDebuggerUrl)
    const evaluate = async (expression) => {
      const result = await connection.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
      return result.result.value
    }
    // A target's URL changes before its old about:blank execution context is
    // replaced. Wait for the React page before sending asynchronous evaluations.
    let pageReady = false
    while (!pageReady && Date.now() < deadline) {
      try {
        pageReady = await evaluate("location.href === 'pdfer://app/' && document.readyState === 'complete' && !!window.pdferDesktop && !!document.querySelector('#panel-merge input[type=file]')")
      } catch (error) { if (!/context was destroyed|Cannot find context/.test(error.message)) throw error }
      if (!pageReady) await pause(100)
    }
    assert.equal(pageReady, true, 'The desktop UI did not finish loading')
    if (process.env.PDFER_SMOKE_PADDLE === '1' && phase === 'write') {
      const state = await evaluate(`(async () => {
        await window.pdferDesktop.installOcr();
        const deadline = Date.now() + 600000;
        while (Date.now() < deadline) {
          const state = await window.pdferDesktop.getOcrSetupState();
          if (state.status !== 'installing') return state;
          await new Promise(r => setTimeout(r, 250));
        }
        throw new Error('PaddleOCR installation timed out');
      })()`)
      assert.equal(state.status, 'ready', JSON.stringify(state))
      console.log('Packaged in-app PaddleOCR setup passed.')
    }
    const ready = await evaluate(`(async () => {
      const deadline = Date.now() + 20000;
      while (!document.querySelector('#panel-merge input[type=file]') && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
      return { bridge: !!window.pdferDesktop, node: typeof window.process,
        // Desktop-only controls render once the page sees the bridge; the update panel itself shows only when there is news.
        updateButton: !!document.querySelector('button[aria-label="Check for updates"]'),
        health: await (await fetch('/api/desktop/health')).json(), ocr: await (await fetch('/api/ocr/status')).json(),
        fonts: (await fetch('/api/fonts')).status, signatures: (await fetch('/api/signatures')).status };
    })()`)
    assert.equal(ready.bridge, true); assert.equal(ready.node, 'undefined'); assert.equal(ready.health.ready, true)
    assert.equal(ready.fonts, 200); assert.equal(ready.signatures, 200)
    assert.equal(ready.ocr.available, true, JSON.stringify(ready.ocr))
    assert.ok(ready.ocr.languages.includes('eng')); assert.equal(ready.ocr.can_rotate, true)
    assert.equal(ready.updateButton, true, 'The desktop update check button did not render')
    if (process.env.PDFER_SMOKE_EXPECT_UNPUBLISHED === '1') {
      const state = await evaluate(`(async () => {
        await window.pdferDesktop.checkForUpdates();
        const deadline=Date.now()+20000;
        while(Date.now()<deadline){
          const state=await window.pdferDesktop.getUpdateState();
          if(state.status!=='checking') return state;
          await new Promise(r=>setTimeout(r,100));
        }
        throw new Error('Update check timed out');
      })()`)
      assert.equal(state.status, 'idle', JSON.stringify(state))
      assert.equal(state.message, 'No published stable release is available yet.')
      console.log('Missing first release is shown as a normal status, not a connection error.')
    }
    const merged = await evaluate(`(async () => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(samplePdf().toString('base64'))}), c => c.charCodeAt(0));
      const file = new File([bytes], 'local-test.pdf', {type:'application/pdf'});
      const data = new FormData(); data.append('files', file); data.append('files', file);
      const response = await fetch('/api/merge', {method:'POST', body:data}); const text = await response.text();
      const edits = new FormData(); edits.append('file', file);
      edits.append('edits', JSON.stringify([{type:'text', page:1, x:10, y:20, text:'Привет', size:12, color:'#000000'}]));
      const edited = await fetch('/api/edit', {method:'POST', body:edits}); const editedText = await edited.text();
      const input = document.querySelector('#panel-merge input[type=file]');
      const transfer = new DataTransfer(); transfer.items.add(file); input.files = transfer.files;
      input.dispatchEvent(new Event('change', {bubbles:true}));
      const deadline = Date.now() + 10000;
      while (!document.querySelector('#panel-merge canvas') && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
      return {status:response.status, pdf:text.startsWith('%PDF-'), editStatus:edited.status, editedPdf:editedText.startsWith('%PDF-'), canvas:!!document.querySelector('#panel-merge canvas'),
        errors:[...document.querySelectorAll('#panel-merge [role=alert]')].map(e => e.textContent)};
    })()`)
    assert.equal(merged.status, 200); assert.equal(merged.pdf, true); assert.equal(merged.canvas, true, JSON.stringify(merged)); assert.deepEqual(merged.errors, [])
    assert.equal(merged.editStatus, 200); assert.equal(merged.editedPdf, true)
    const stored = await evaluate(`(async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('pdfer-desktop-smoke', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('state');
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      const phase = ${JSON.stringify(phase)};
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('state', phase === 'write' ? 'readwrite' : 'readonly');
        const store = tx.objectStore('state'); let value;
        if (phase === 'write') store.put('survives restart', 'project');
        const request = store.get('project'); request.onsuccess = () => { value = request.result };
        tx.oncomplete = () => { db.close(); resolve(value) }; tx.onerror = () => reject(tx.error);
      });
    })()`)
    assert.equal(stored, 'survives restart')
    const recognized = await evaluate(`(async () => {
      const canvas=document.createElement('canvas'); canvas.width=1000; canvas.height=220;
      const ctx=canvas.getContext('2d'); ctx.fillStyle='white'; ctx.fillRect(0,0,1000,220);
      ctx.fillStyle='black'; ctx.font='bold 64px Arial'; ctx.fillText('LOCAL OCR TEST 12345',40,130);
      const image=await new Promise(r=>canvas.toBlob(r,'image/png'));
      const body=new FormData(); body.append('image',image,'scan.png'); body.append('languages','eng'); body.append('dpi','150');
      const response=await fetch('/api/ocr/page',{method:'POST',body});
      const output=await response.text();
      return {status:response.status, pdf:output.startsWith('%PDF-'), error:response.ok ? undefined : output};
    })()`)
    assert.equal(recognized.status, 200, JSON.stringify(recognized)); assert.equal(recognized.pdf, true)
    if (process.env.PDFER_SMOKE_PADDLE === '1') {
      const paddle = await evaluate(`(async () => {
        const canvas=document.createElement('canvas'); canvas.width=1000; canvas.height=220;
        const ctx=canvas.getContext('2d'); ctx.fillStyle='white'; ctx.fillRect(0,0,1000,220);
        ctx.fillStyle='black'; ctx.font='bold 64px Arial'; ctx.fillText('LOCAL OCR TEST 12345',40,130);
        const image=await new Promise(r=>canvas.toBlob(r,'image/png'));
        const body=new FormData(); body.append('image',image,'scan.png'); body.append('languages','auto');
        body.append('dpi','150'); body.append('engine','paddleocr');
        const response=await fetch('/api/ocr/page',{method:'POST',body});
        return {status:response.status, pdf:(await response.text()).startsWith('%PDF-')};
      })()`)
      assert.equal(paddle.status, 200); assert.equal(paddle.pdf, true)
      console.log('Packaged PaddleOCR recognition passed.')
    }
    await fs.mkdir(path.join(root, 'desktop/build'), { recursive: true })
    const screenshot = await connection.call('Page.captureScreenshot', { format: 'png' })
    await fs.writeFile(path.join(root, `desktop/build/smoke-${phase}.png`), Buffer.from(screenshot.data, 'base64'))
    console.log(`Packaged app (${phase}): private backend, merge, PDF.js preview, OCR, isolated renderer and persistent storage passed.`)
    // Closing destroys the inspected execution context; CDP can report that
    // before delivering its acknowledgement. The process exit below is the check.
    try { await connection.call('Page.close') }
    catch (error) { if (!/context was destroyed|debugger disconnected|Target closed|Session closed/.test(error.message)) throw error }
    connection.socket.close()
    assert.equal(await Promise.race([exit, pause(10000).then(() => 'timeout')]), 0, 'Application did not shut down cleanly')
  } finally {
    connection?.socket.close()
    if (child.exitCode === null && child.pid) {
      child.kill('SIGTERM')
      await Promise.race([exit, pause(5000)])
      if (child.exitCode === null) child.kill('SIGKILL')
    }
  }
}

async function main() {
  const dataDir = process.env.PDFER_SMOKE_DATA_DIR || await fs.mkdtemp(path.join(os.tmpdir(), 'pdfer-installed-'))
  try { await run(dataDir, 'write'); await run(dataDir, 'read') }
  finally { if (!process.env.PDFER_SMOKE_DATA_DIR) await fs.rm(dataDir, { recursive: true, force: true }) }
}
module.exports = { connect }
if (require.main === module) main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1) })
