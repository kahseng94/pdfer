import { describe, expect, it } from 'vitest'
import { boxFromDrag, builderProblem, movedBox, newField, nextName, resizedBox, toSpec, type DraftField } from './formBuilder'

const page = { width: 200, height: 300 }
const field = (patch: Partial<DraftField> = {}): DraftField => ({
  id: crypto.randomUUID(), page: 1, type: 'text', name: 'Name', label: '', required: false, multiline: false, maxLength: null,
  options: [], editable: false, option: '', x: 10, y: 10, width: 100, height: 20, ...patch,
})

describe('placing fields', () => {
  it('names new fields after the first free number', () => {
    expect(nextName('text', ['Text 1', 'Text 3'])).toBe('Text 2')
    expect(nextName('radio', [])).toBe('Radio group 1')
  })

  it('places a default-sized field on a click and keeps drags on the page and at least 8 points', () => {
    expect(boxFromDrag('text', { x: 20, y: 30 }, { x: 21, y: 31 }, page)).toEqual({ x: 20, y: 30, width: 160, height: 22 })
    expect(boxFromDrag('text', { x: 190, y: 30 }, { x: 190, y: 30 }, page)).toEqual({ x: 40, y: 30, width: 160, height: 22 })
    expect(boxFromDrag('checkbox', { x: 50, y: 50 }, { x: 55, y: 52 }, page)).toEqual({ x: 50, y: 50, width: 8, height: 8 })
    expect(boxFromDrag('text', { x: 150, y: 250 }, { x: 260, y: 400 }, page)).toEqual({ x: 150, y: 250, width: 50, height: 50 })
  })

  it('moves and resizes within the page without going under the minimum size', () => {
    const box = { x: 10, y: 10, width: 100, height: 20 }
    expect(movedBox(box, 500, -50, page)).toEqual({ x: 100, y: 0, width: 100, height: 20 })
    expect(resizedBox(box, 'w', 200, 0, page)).toEqual({ x: 102, y: 10, width: 8, height: 20 })
    expect(resizedBox(box, 'se', 500, 500, page)).toEqual({ x: 10, y: 10, width: 190, height: 290 })
    expect(resizedBox(box, 'n', 0, -40, page)).toEqual({ x: 10, y: 0, width: 100, height: 30 })
  })

  it('adds radio buttons to the given group with the next free option', () => {
    const first = newField('radio', 1, { x: 0, y: 0, width: 14, height: 14 }, [], [])
    const second = newField('radio', 1, { x: 20, y: 0, width: 14, height: 14 }, [first], [], first.name)
    expect([first.name, first.option, second.name, second.option]).toEqual(['Radio group 1', 'Option 1', 'Radio group 1', 'Option 2'])
    expect(newField('text', 1, { x: 0, y: 0, width: 50, height: 20 }, [first], ['Text 1']).name).toBe('Text 2')
  })
})

describe('builderProblem', () => {
  const check = (fields: DraftField[], existing: string[] = [], count = existing.length) => builderProblem(fields, existing, count, [page])

  it('accepts valid fields of every type', () => {
    expect(check([
      field(),
      field({ type: 'checkbox', name: 'Agree' }),
      field({ type: 'choice', name: 'Country', options: ['Canada', '', 'France'] }),
      field({ type: 'radio', name: 'Plan', option: 'A' }),
      field({ type: 'radio', name: 'Plan', option: 'B' }),
    ])).toBeNull()
  })

  it.each([
    [[field({ name: ' ' })], "the name can't be empty"],
    [[field({ name: 'a.b' })], 'full stop'],
    [[field({ label: 'tab\there' })], 'control characters'],
    [[field({ width: 6 })], 'at least 8 points'],
    [[field({ x: 150 })], 'must fit on page 1'],
    [[field({ maxLength: 0 })], 'maximum length'],
    [[field({ type: 'choice', options: [' ', ''] })], '1 to 100 options'],
    [[field({ type: 'choice', options: ['A', 'A '] })], 'different from each other'],
    [[field({ type: 'radio', option: 'A' })], 'at least 2 buttons'],
    [[field({ type: 'radio', option: 'A' }), field({ type: 'radio', option: 'A' })], 'same option'],
    [[field({ type: 'radio', option: 'Off' }), field({ type: 'radio', option: 'On' })], 'reserved'],
    [[field(), field()], 'another new field'],
    [[field({ type: 'radio', option: 'A' }), field({ type: 'radio', option: 'B' }), field()], 'another new field'],
  ])('explains %#', (fields, message) => {
    expect(check(fields)).toContain(message)
  })

  it('refuses names the PDF already uses and more than 500 fields in total', () => {
    expect(check([field()], ['Name'])).toContain('already has a field')
    expect(check([field()], ['Other'], 500)).toContain('at most 500 fields')
  })
})

it('sends only the settings that apply to each field type', () => {
  expect(toSpec([
    field({ name: ' Full name ', label: ' Yours ', required: true, maxLength: 40, x: 10.123, multiline: true, options: ['ignored'] }),
    field({ type: 'choice', name: 'Country', options: [' Canada ', '', 'France'], editable: true, maxLength: 5 }),
    field({ type: 'radio', name: 'Plan', option: ' A ', multiline: true }),
  ])).toEqual([
    { type: 'text', name: 'Full name', page: 1, x: 10.12, y: 10, width: 100, height: 20, label: 'Yours', required: true, multiline: true, maxLength: 40 },
    { type: 'choice', name: 'Country', page: 1, x: 10, y: 10, width: 100, height: 20, options: ['Canada', 'France'], editable: true },
    { type: 'radio', name: 'Plan', page: 1, x: 10, y: 10, width: 100, height: 20, option: 'A' },
  ])
})
