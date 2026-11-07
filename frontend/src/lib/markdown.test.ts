// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyEdit, continueList, decodeText, insertLink, insertTable, loadDraft, loadMode, markdownName, renderMarkdown, saveDraft,
  saveMode, slug, taskMarkers, toggleCode, toggleLines, toggleTask, toggleWrap, type Edit,
} from './markdown'

afterEach(() => localStorage.clear())

/** The text after an edit, with the selection shown as [ and ]. */
function show(value: string, edit: Edit | null): string {
  if (!edit) return 'no edit'
  const next = applyEdit(value, edit)
  const [start, end] = edit.select
  return next.slice(0, start) + '[' + next.slice(start, end) + ']' + next.slice(end)
}

describe('renderMarkdown', () => {
  function html(source: string) {
    const node = document.createElement('div')
    node.innerHTML = renderMarkdown(source).html
    return node
  }

  it('shows raw HTML as text and removes links that could run code', () => {
    const node = html('<script>alert(1)</script> <img src=x onerror=alert(1)>\n\n[run](javascript:alert(1)) [file](docs/a.md)')
    expect(node.querySelector('script, img')).toBeNull()
    expect(node.textContent).toContain('<script>alert(1)</script>')
    const [run, file] = node.querySelectorAll('a')
    expect(run.getAttribute('href')).toBe('')
    expect(run.hasAttribute('data-unavailable')).toBe(true)
    expect(file.title).toContain('docs/a.md')
    expect(file.hasAttribute('data-unavailable')).toBe(true)
  })

  it('opens web links in a new tab without passing on where they came from', () => {
    const link = html('[site](https://example.com) and www.example.org').querySelectorAll('a')
    expect([...link].map((a) => [a.getAttribute('href'), a.target, a.rel])).toEqual([
      ['https://example.com', '_blank', 'noopener noreferrer'],
      ['http://www.example.org', '_blank', 'noopener noreferrer'],
    ])
  })

  it('never loads pictures, showing their description instead', () => {
    const rendered = renderMarkdown('![Team photo](https://example.com/t.png) ![](img/local.png)')
    const node = html('![Team photo](https://example.com/t.png) ![](img/local.png)')
    expect(rendered.images).toBe(2)
    expect(node.querySelector('img')).toBeNull()
    expect([...node.querySelectorAll('[role=img]')].map((n) => [n.textContent, n.getAttribute('title')])).toEqual([
      ['Team photo', 'Image not shown: https://example.com/t.png'],
      ['Image', 'Image not shown: img/local.png'],
    ])
  })

  it('gives headings GitHub anchors without adding ids to the page', () => {
    const node = html('# Hello *world*\n\n## Hello world\n\n## Café & crème!\n\nText[^1]\n\n[^1]: Note.')
    expect([...node.querySelectorAll('h1, h2')].map((h) => h.getAttribute('data-anchor'))).toEqual(['hello-world', 'hello-world-1', 'café--crème', 'footnote-label'])
    expect(node.querySelector('[id], [aria-describedby]')).toBeNull()
    expect(slug('  A_b-C 1 ')).toBe('a_b-c-1')
  })

  it('renders GitHub tables, strikethrough and tickable task lists, and counts words', () => {
    const rendered = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\n\n~~old~~ new\n\n- [ ] buy tea\n- [x] wash cup')
    const node = html('| a | b |\n|---|---|\n| 1 | 2 |\n\n~~old~~ new\n\n- [ ] buy tea\n- [x] wash cup')
    expect(node.querySelectorAll('td')).toHaveLength(2)
    expect(node.querySelector('del')!.textContent).toBe('old')
    const boxes = [...node.querySelectorAll<HTMLInputElement>('input[type=checkbox]')]
    expect(boxes.map((b) => [b.disabled, b.checked, b.dataset.task, b.getAttribute('aria-label')])).toEqual([
      [false, false, '0', 'Done: buy tea'], [false, true, '1', 'Done: wash cup'],
    ])
    expect(rendered.tasks).toBe(2)
    expect(rendered.words).toBe(10)
  })
})

describe('task lists', () => {
  it('finds each checkbox mark, skipping code blocks, and ticks or unticks it', () => {
    const source = '- [ ] one\n```\n- [ ] not a task\n```\n> 1. [x] quoted\n  * [ ] nested\n- [ ]no space'
    const markers = taskMarkers(source)
    expect(markers.map((at) => source[at])).toEqual([' ', 'x', ' '])
    expect(toggleTask(source, markers[0]).split('\n')[0]).toBe('- [x] one')
    expect(toggleTask(source, markers[1]).split('\n')[4]).toBe('> 1. [ ] quoted')
    expect(markers).toHaveLength(renderMarkdown(source).tasks)
  })
})

describe('formatting edits', () => {
  it('wraps and unwraps the selection', () => {
    expect(show('a word here', toggleWrap('a word here', 2, 6, '**', 'bold'))).toBe('a **[word]** here')
    expect(show('a **word** here', toggleWrap('a **word** here', 4, 8, '**', 'bold'))).toBe('a [word] here')
    expect(show('a **word** here', toggleWrap('a **word** here', 2, 10, '**', 'bold'))).toBe('a [word] here')
    expect(show('ab', toggleWrap('ab', 1, 1, '_', 'italic text'))).toBe('a_[italic text]_b')
  })

  it('turns lines into lists, quotes and headings, and back', () => {
    const text = 'one\n\ntwo'
    expect(show(text, toggleLines(text, 0, text.length, 'bullet'))).toBe('[- one\n\n- two]')
    expect(show(text, toggleLines(text, 0, text.length, 'number'))).toBe('[1. one\n\n2. two]')
    expect(show('- a\n- b', toggleLines('- a\n- b', 0, 7, 'number'))).toBe('[1. a\n2. b]')
    expect(show('- a\n- b', toggleLines('- a\n- b', 0, 7, 'bullet'))).toBe('[a\nb]')
    expect(show('- [x] a', toggleLines('- [x] a', 0, 7, 'task'))).toBe('[a]')
    expect(show('a', toggleLines('a', 0, 1, 'task'))).toBe('[- [ ] a]')
    expect(show('a', toggleLines('a', 1, 1, 'quote'))).toBe('> a[]')
    expect(show('title', toggleLines('title', 2, 2, 'heading'))).toBe('# ti[]tle')
    expect(show('### title', toggleLines('### title', 9, 9, 'heading'))).toBe('title[]')
  })

  it('inserts links, code and tables', () => {
    expect(show('see docs', insertLink('see docs', 4, 8))).toBe('see [docs]([https://])')
    expect(show('', insertLink('', 0, 0))).toBe('[[link text]](https://)')
    expect(show('x = 1', toggleCode('x = 1', 0, 5))).toBe('`[x = 1]`')
    expect(show('a\nb', toggleCode('a\nb', 0, 3))).toBe('[```\na\nb\n```]')
    expect(show('```\na\n```', toggleCode('```\na\n```', 0, 9))).toBe('[a]')
    expect(show('', insertTable('', 0))).toBe('| [Column] | Column |\n| --- | --- |\n|  |  |')
    expect(show('Intro\nMore', insertTable('Intro\nMore', 2))).toBe('Intro\n\n| [Column] | Column |\n| --- | --- |\n|  |  |\n\nMore')
    expect(show('Intro\n', insertTable('Intro\n', 6))).toBe('Intro\n\n| [Column] | Column |\n| --- | --- |\n|  |  |')
  })

  it('continues lists and quotes on Enter, and ends them on an empty item', () => {
    expect(show('- milk', continueList('- milk', 6))).toBe('- milk\n- []')
    expect(show('  9. nine', continueList('  9. nine', 9))).toBe('  9. nine\n  10. []')
    expect(show('* [x] done', continueList('* [x] done', 10))).toBe('* [x] done\n* [ ] []')
    expect(show('> said', continueList('> said', 6))).toBe('> said\n> []')
    expect(show('- a\n- ', continueList('- a\n- ', 6))).toBe('- a\n[]')
    expect(continueList('plain', 5)).toBeNull()
  })
})

describe('files and storage', () => {
  it('reads UTF-8, UTF-16 and Windows-1252 text', () => {
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x63, 0x61, 0x66, 0xc3, 0xa9]).buffer)).toEqual({ text: 'café', encoding: 'UTF-8' })
    expect(decodeText(new Uint8Array([0x63, 0x61, 0x66, 0xe9]).buffer)).toEqual({ text: 'café', encoding: 'Windows-1252' })
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]).buffer)).toEqual({ text: 'hi', encoding: 'UTF-16' })
  })

  it('names downloads and keeps drafts and the view between sessions', () => {
    expect(markdownName('notes')).toBe('notes.md')
    expect(markdownName('read me.markdown')).toBe('read me.markdown')
    expect(markdownName(' a/b ')).toBe('a_b.md')
    expect(markdownName('')).toBe('Untitled.md')
    saveDraft({ name: 'n.md', text: '# Hi', edited: true, crlf: false })
    expect(loadDraft()).toEqual({ name: 'n.md', text: '# Hi', edited: true, crlf: false })
    saveDraft({ name: 'big.md', text: 'x'.repeat(1_000_001), edited: true, crlf: false })
    expect(loadDraft()).toBeNull()
    localStorage.setItem('pdfer.markdown.draft', '{"name": 3}')
    expect(loadDraft()).toBeNull()
    expect(loadMode()).toBe('split')
    saveMode('preview')
    expect(loadMode()).toBe('preview')
  })
})
