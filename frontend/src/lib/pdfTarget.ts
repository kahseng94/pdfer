export type PdfTargetUnit = 'KB' | 'MB'
export const MIN_PDF_TARGET = 1_000
export const MAX_PDF_TARGET = 500_000_000

export function validatePdfTarget(bytes: number): number {
  if (!Number.isSafeInteger(bytes) || bytes < MIN_PDF_TARGET || bytes > MAX_PDF_TARGET) {
    throw new Error('Choose a target from 1 KB to 500 MB, in whole bytes.')
  }
  return bytes
}

/** Decimal upload limits: 1 KB = 1,000 bytes; 1 MB = 1,000,000 bytes. */
export function parsePdfTarget(value: string, unit: PdfTargetUnit): number {
  if ((unit !== 'KB' && unit !== 'MB') || !/^\d+(?:\.\d+)?$/.test(value.trim())) {
    throw new Error('Enter a positive size in KB or MB.')
  }
  // Decimal parsing avoids silently rounding a fractional byte or crossing a
  // limit because of floating-point multiplication.
  const [whole, fraction = ''] = value.trim().split('.')
  const digits = unit === 'MB' ? 6 : 3
  if (/[1-9]/.test(fraction.slice(digits))) throw new Error('The target must be a whole number of bytes.')
  return validatePdfTarget(Number(whole) * 10 ** digits + Number(fraction.slice(0, digits).padEnd(digits, '0')))
}

export function targetSizeLabel(bytes: number): string {
  return `${(bytes / (bytes >= 1_000_000 ? 1_000_000 : 1_000)).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${bytes >= 1_000_000 ? 'MB' : 'KB'}`
}
