// Canvas encoders use 96 dpi. Keep the image's physical size consistent with
// the resolution used to render its PDF page, without re-encoding its pixels.

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** Set PNG pHYs or JPEG JFIF density on an image produced by canvas.toBlob. */
export function withImageDpi(bytes: Uint8Array<ArrayBuffer>, format: 'png' | 'jpeg', dpi: number): Uint8Array<ArrayBuffer> {
  if (format === 'jpeg') {
    // Update the existing JFIF header, when the browser supplied one.
    for (let offset = 2; offset + 4 <= bytes.length && bytes[offset] === 0xff;) {
      const marker = bytes[offset + 1]
      if (marker === 0xda || marker === 0xd9) break
      const length = (bytes[offset + 2] << 8) | bytes[offset + 3]
      if (length < 2 || offset + length + 2 > bytes.length) break
      if (marker === 0xe0 && length >= 16 && String.fromCharCode(...bytes.subarray(offset + 4, offset + 9)) === 'JFIF\0') {
        bytes[offset + 11] = 1 // dots per inch
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        view.setUint16(offset + 12, dpi)
        view.setUint16(offset + 14, dpi)
        return bytes
      }
      offset += length + 2
    }
    // Some encoders omit JFIF. Insert the standard 18-byte segment after SOI.
    const header = new Uint8Array([0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 1, dpi >> 8, dpi & 255, dpi >> 8, dpi & 255, 0, 0])
    const out = new Uint8Array(bytes.length + header.length)
    out.set(bytes.subarray(0, 2))
    out.set(header, 2)
    out.set(bytes.subarray(2), 2 + header.length)
    return out
  }

  const density = new Uint8Array(21)
  const densityView = new DataView(density.buffer)
  densityView.setUint32(0, 9)
  density.set([112, 72, 89, 115], 4) // pHYs
  const perMetre = Math.round(dpi / 0.0254)
  densityView.setUint32(8, perMetre)
  densityView.setUint32(12, perMetre)
  density[16] = 1 // pixels per metre
  densityView.setUint32(17, crc32(density.subarray(4, 17)))

  // Place density after IHDR and remove any old pHYs chunk.
  const parts: Uint8Array[] = [bytes.subarray(0, 33), density]
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let offset = 33; offset + 12 <= bytes.length;) {
    const end = offset + view.getUint32(offset) + 12
    if (end > bytes.length) throw new Error('Could not encode the PNG image.')
    if (view.getUint32(offset + 4) !== 0x70485973) parts.push(bytes.subarray(offset, end))
    offset = end
  }
  const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}
