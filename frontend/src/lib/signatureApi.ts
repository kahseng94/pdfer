export type SavedSignature = { id: string; name: string; width: number; height: number; created_at: string }
export type PreparedSignature = { file: File; width: number; height: number }

async function request(path: string, options: RequestInit = {}): Promise<Response> {
  let response: Response
  try { response = await fetch(path, { ...options, cache: 'no-store' }) }
  catch {
    options.signal?.throwIfAborted()
    throw new Error("Can't reach the local signature library. Is pdfer running?")
  }
  if (!response.ok) {
    const detail = await response.json().then((body: { detail?: unknown }) => typeof body.detail === 'string' ? body.detail : null).catch(() => null)
    throw new Error(detail ?? `The signature request failed (HTTP ${response.status}).`)
  }
  return response
}

export async function listSignatures(signal?: AbortSignal): Promise<SavedSignature[]> {
  return (await request('/api/signatures', { signal })).json()
}

export function signatureImageUrl(id: string): string {
  return `/api/signatures/${encodeURIComponent(id)}/image`
}

export async function signatureImage(signature: SavedSignature, signal?: AbortSignal): Promise<File> {
  const blob = await (await request(signatureImageUrl(signature.id), { signal })).blob()
  return new File([blob], `${signature.name}.png`, { type: 'image/png' })
}

export async function prepareSignature(file: File, removeWhite: boolean, signal?: AbortSignal): Promise<PreparedSignature> {
  const body = new FormData()
  body.append('file', file)
  body.append('remove_white', String(removeWhite))
  const response = await request('/api/signatures/prepare', { method: 'POST', body, signal })
  const width = Number(response.headers.get('x-image-width'))
  const height = Number(response.headers.get('x-image-height'))
  if (!(width > 0 && height > 0)) throw new Error('The prepared signature dimensions could not be read.')
  return { file: new File([await response.blob()], 'signature.png', { type: 'image/png' }), width, height }
}

export async function saveSignature(file: File, name: string): Promise<SavedSignature> {
  const body = new FormData()
  body.append('file', file)
  body.append('name', name)
  return (await request('/api/signatures', { method: 'POST', body })).json()
}

export async function deleteSignature(id: string): Promise<void> {
  await request(`/api/signatures/${encodeURIComponent(id)}`, { method: 'DELETE' })
}
