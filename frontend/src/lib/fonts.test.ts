import { afterEach, describe, expect, it } from 'vitest'
import { familyCss, fontCss, needsEmbeddedFont, setFontInfo, unsupportedChars, type CodeRange } from './fonts'

// Printable ASCII, Latin-1, Greek and Cyrillic, like DejaVu.
const coverage: CodeRange[] = [
  [0x20, 0x7e],
  [0xa0, 0xff],
  [0x370, 0x3ff],
  [0x400, 0x4ff],
]

afterEach(() => setFontInfo(null))

describe('needsEmbeddedFont', () => {
  it('is false for everything the standard fonts have', () => {
    expect(needsEmbeddedFont('Héllo wörld — “quotes” €5 • ok\nnext line')).toBe(false)
  })

  it('is true as soon as one character is beyond them', () => {
    expect(needsEmbeddedFont('Hello Ж')).toBe(true)
  })
})

describe('unsupportedChars', () => {
  it('is empty for Latin text whatever the coverage', () => {
    expect(unsupportedChars('Héllo', [])).toEqual([])
  })

  it('lists each character outside the coverage once', () => {
    expect(unsupportedChars('Привет 你好, 你 ☃', coverage)).toEqual(['你', '好', '☃'])
  })

  it('ignores line breaks', () => {
    expect(unsupportedChars('Ж\nλ', coverage)).toEqual([])
  })

  it('uses the loaded fonts by default', () => {
    expect(unsupportedChars('Ж')).toEqual(['Ж'])
    setFontInfo({ families: { sans: [], serif: [], mono: [] }, coverage })
    expect(unsupportedChars('Ж')).toEqual([])
  })
})

describe('familyCss', () => {
  it('names the standard stacks for Latin text', () => {
    expect(familyCss('serif', 'Hello')).toBe("'Times New Roman', Times, serif")
    expect(familyCss('mono')).toBe("'Courier New', Courier, monospace")
  })

  it('switches to the embedded chain when the text needs it and the fonts are loaded', () => {
    expect(familyCss('serif', 'Ж')).toBe("'Times New Roman', Times, serif")
    setFontInfo({ families: { sans: ['DejaVuSans.ttf'], serif: ['DejaVuSerif.ttf', 'DejaVuSans.ttf'], mono: [] }, coverage })
    expect(familyCss('serif', 'Ж')).toBe('"pdfer DejaVuSerif", "pdfer DejaVuSans", sans-serif')
    expect(familyCss('serif', 'Hello')).toBe("'Times New Roman', Times, serif")
    expect(familyCss('mono', 'Ж')).toBe("'Courier New', Courier, monospace")
  })
})

describe('fontCss', () => {
  it('builds the shorthand with weight, style and scale', () => {
    expect(fontCss({ size: 12, family: 'sans', bold: true, italic: true, text: 'x' }, 2)).toBe('italic bold 24px Helvetica, Arial, sans-serif')
  })
})
