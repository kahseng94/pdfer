import { describe, expect, it } from 'vitest'
import { fitSignature, initialSignatureBox, inkBounds, signaturePayload, type SignaturePlacement } from './signatures'

const page = { width: 600, height: 800, unit: 1 }
const file = new File(['image'], 'signature.png', { type: 'image/png' })
const placement: SignaturePlacement = { id:'one', type:'image', page:1, signatureId:'saved', label:'Signature', aspect:3, file, url:'blob:signature', x:100,y:200,width:180,height:60 }

describe('signature drawing and placement', () => {
  it('rejects empty ink and keeps padding around strokes and dots', () => {
    expect(inkBounds([])).toBeNull()
    expect(inkBounds([{ points:[[30,40]], color:'#000000', width:4 }])).toEqual({ x:20,y:30,width:20,height:20 })
    expect(inkBounds([{ points:[[20,40],[80,10]], color:'#000000', width:4 }])).toEqual({ x:10,y:0,width:80,height:50 })
  })
  it('starts inside the page near the bottom and keeps proportions', () => {
    const box = initialSignatureBox(3, page)
    expect(box.width / box.height).toBe(3)
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.y + box.height).toBe(776)
    const tiny = initialSignatureBox(8, { width:20,height:10,unit:1 })
    expect(tiny.width).toBeLessThan(20)
    expect(tiny.height).toBeLessThan(10)
  })
  it('clamps dragging and resizing to the visible page without distorting the signature', () => {
    const fitted = fitSignature({ ...placement, x:-10,y:900,width:900,height:12 }, page)
    expect(fitted).toMatchObject({ x:0,y:600,width:600,height:200 })
    expect(fitted.file).toBe(file)
    expect(fitSignature({ ...placement, width:0 },page).width).toBe(12)
  })
  it('shares the same signature image across pages and accounts for PDF user units', () => {
    const result = signaturePayload([placement, { ...placement,id:'two',page:2 }], [page,{...page,unit:2}])
    expect(result.images).toEqual([file])
    expect(result.edits).toEqual([
      {type:'image',page:1,x:100,y:200,width:180,height:60,image:0},
      {type:'image',page:2,x:50,y:100,width:90,height:30,image:0},
    ])
  })
  it('rejects placements on a missing page', () => {
    expect(() => signaturePayload([placement],[])).toThrow('no longer open')
  })
})
