import { describe, expect, it, vi } from 'vitest'
import { currentPasswordPrompt, passwordProblem, pdfPassword, rememberPdfPassword, requestPdfPassword, subscribePasswordPrompt } from './passwords'

describe('session passwords', () => {
  it('belongs to the exact file, so a different file with the same name never inherits its password', () => {
    const first = new File(['a'], 'same.pdf')
    const other = new File(['b'], 'same.pdf')
    rememberPdfPassword(first, '  exact password  ')
    expect(pdfPassword(first)).toBe('  exact password  ')
    expect(pdfPassword(other)).toBe('')
    rememberPdfPassword(first, '')
    expect(pdfPassword(first)).toBe('')
  })

  it('validates UTF-8 byte length without trimming passwords', () => {
    expect(passwordProblem('')).toBeTruthy()
    expect(passwordProblem('x'.repeat(127))).toBeNull()
    expect(passwordProblem('é'.repeat(64))).toContain('127')
    expect(passwordProblem('bad\0password')).toBeTruthy()
    expect(passwordProblem('  exact password  ')).toBeNull()
  })
})

describe('password prompt queue', () => {
  it('keeps concurrent files separate and delivers each password to the correct caller', async () => {
    const changed = vi.fn()
    const unsubscribe = subscribePasswordPrompt(changed)
    const first = requestPdfPassword('one.pdf', false, new AbortController().signal)
    const second = requestPdfPassword('two.pdf', true, new AbortController().signal)
    expect(currentPasswordPrompt()?.filename).toBe('one.pdf')
    currentPasswordPrompt()?.submit('first secret')
    await expect(first).resolves.toBe('first secret')
    expect(currentPasswordPrompt()).toMatchObject({ filename: 'two.pdf', incorrect: true })
    currentPasswordPrompt()?.submit('second secret')
    await expect(second).resolves.toBe('second secret')
    expect(currentPasswordPrompt()).toBeNull()
    expect(changed).toHaveBeenCalledTimes(4)
    unsubscribe()
  })

  it('removes aborted requests, including a file waiting behind the visible prompt', async () => {
    const first = requestPdfPassword('one.pdf', false, new AbortController().signal)
    const firstRejected = expect(first).rejects.toMatchObject({ name: 'AbortError' })
    const controller = new AbortController()
    const second = requestPdfPassword('two.pdf', false, controller.signal)
    const secondRejected = expect(second).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await secondRejected
    expect(currentPasswordPrompt()?.filename).toBe('one.pdf')
    currentPasswordPrompt()?.cancel()
    await firstRejected
    expect(currentPasswordPrompt()).toBeNull()
  })

  it('does not queue an already cancelled request', () => {
    expect(() => requestPdfPassword('closed.pdf', false, AbortSignal.abort())).toThrow()
    expect(currentPasswordPrompt()).toBeNull()
  })
})
