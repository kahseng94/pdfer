// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DesktopApi, OcrSetupState, UpdateState } from '../lib/desktop'
import { DesktopOcrSetup, DesktopUpdates } from './DesktopControls'

let container: HTMLDivElement, root: Root, update: (state: UpdateState) => void, ocr: (state: OcrSetupState) => void
let api: DesktopApi
const base: UpdateState = { status: 'idle', currentVersion: '0.1.0' }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  api = {
    getUpdateState: vi.fn(async () => base), checkForUpdates: vi.fn(async () => base),
    downloadUpdate: vi.fn(async () => base), installUpdate: vi.fn(async () => true),
    onUpdateState: vi.fn((callback) => { update = callback; return vi.fn() }),
    getOcrSetupState: vi.fn(async () => ({ status: 'idle' as const })), installOcr: vi.fn(async () => ({ status: 'installing' as const })),
    onOcrSetupState: vi.fn((callback) => { ocr = callback; return vi.fn() }),
  }
  window.pdferDesktop = api
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); delete window.pdferDesktop; vi.unstubAllGlobals() })
async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find((node) => node.textContent === label)
  expect(button).toBeTruthy()
  await act(async () => button!.click())
}

it('keeps desktop controls out of the browser application', async () => {
  delete window.pdferDesktop
  await act(async () => root.render(<DesktopUpdates />))
  expect(container.textContent).toBe('')
})

it('requires user actions to download and install, and shows progress', async () => {
  await act(async () => root.render(<DesktopUpdates />))
  await click('Check for updates')
  expect(api.checkForUpdates).toHaveBeenCalledOnce()
  await act(async () => update({ ...base, status: 'available', version: '0.2.0' }))
  expect(api.downloadUpdate).not.toHaveBeenCalled()
  await click('Download update')
  expect(api.downloadUpdate).toHaveBeenCalledOnce()
  await act(async () => update({ ...base, status: 'downloading', percent: 45 }))
  expect(container.querySelector('progress')?.value).toBe(45)
  await act(async () => update({ ...base, status: 'downloaded', version: '0.2.0' }))
  expect(api.installUpdate).not.toHaveBeenCalled()
  await click('Restart to update')
  expect(api.installUpdate).toHaveBeenCalledOnce()
})

it('leaves failed checks retryable and reports failed restart requests', async () => {
  await act(async () => root.render(<DesktopUpdates />))
  await act(async () => update({ ...base, status: 'error', message: 'Check your connection.' }))
  expect(container.textContent).toContain('Check your connection.')
  await click('Check for updates')
  await act(async () => update({ ...base, status: 'downloaded', version: '0.2.0' }))
  vi.mocked(api.installUpdate).mockResolvedValue(false)
  await click('Restart to update')
  expect(container.querySelector('[role=alert]')?.textContent).toContain('OCR installation')
})

it('downloads optional OCR only on request and refreshes engine status after setup', async () => {
  const ready = vi.fn()
  await act(async () => root.render(<DesktopOcrSetup onReady={ready} />))
  expect(api.installOcr).not.toHaveBeenCalled()
  await click('Install PaddleOCR')
  expect(api.installOcr).toHaveBeenCalledOnce()
  expect(container.textContent).toContain('Keep pdfer open')
  await act(async () => ocr({ status: 'ready' }))
  expect(ready).toHaveBeenCalledOnce()
})
