const path = require('node:path')
const { readFile } = require('node:fs/promises')

const APP_URL = 'pdfer://app/'
const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' data:; connect-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'"
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm' }

function isAppURL(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'pdfer:' && url.hostname === 'app' && !url.port && !url.username && !url.password
  } catch { return false }
}

function createHandler(frontendRoot, backend) {
  const root = path.resolve(frontendRoot)
  return async (request) => {
    if (!isAppURL(request.url)) return new Response('Not found', { status: 404 })
    const url = new URL(request.url)
    if (url.pathname.startsWith('/api/')) {
      const headers = new Headers({ 'x-pdfer-token': backend.token, origin: backend.url, 'sec-fetch-site': 'same-origin' })
      for (const name of ['content-type', 'accept']) {
        const value = request.headers.get(name)
        if (value) headers.set(name, value)
      }
      try {
        const response = await fetch(`${backend.url}${url.pathname}${url.search}`, {
          method: request.method, headers, redirect: 'error', signal: request.signal,
          ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body: request.body, duplex: 'half' }),
        })
        const outgoing = new Headers(response.headers)
        outgoing.set('Cache-Control', 'no-store')
        outgoing.set('X-Content-Type-Options', 'nosniff')
        return new Response(response.body, { status: response.status, headers: outgoing })
      } catch {
        return Response.json({ detail: 'The local PDF engine is unavailable. Please restart pdfer.' }, { status: 503 })
      }
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 })
    try {
      const name = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)
      const file = path.resolve(root, `.${name}`)
      if (!file.startsWith(root + path.sep) || name.includes('\\') || name.includes('\0')) return new Response(null, { status: 403 })
      const data = await readFile(file)
      return new Response(request.method === 'HEAD' ? null : data, { headers: {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache',
      } })
    } catch { return new Response('Not found', { status: 404 }) }
  }
}

module.exports = { APP_URL, CSP, isAppURL, createHandler }
