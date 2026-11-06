export const METADATA_FIELDS = [
  { id: 'title', label: 'Title' },
  { id: 'author', label: 'Author' },
  { id: 'subject', label: 'Subject' },
  { id: 'keywords', label: 'Keywords' },
] as const
export const METADATA_READ_ONLY = [
  { id: 'creator', label: 'Creator' },
  { id: 'producer', label: 'Producer' },
  { id: 'created', label: 'Created' },
  { id: 'modified', label: 'Modified' },
  { id: 'metadataDate', label: 'Metadata date' },
] as const
export type MetadataField = typeof METADATA_FIELDS[number]['id']
export type MetadataValue = { value: string | null; xmp: string | null; documentInfo: string | null; conflict: boolean }
export type MetadataSchema = {
  fields: Record<MetadataField | typeof METADATA_READ_ONLY[number]['id'], MetadataValue>
  hasXmp: boolean; hasDocumentInfo: boolean; canEdit: boolean; warnings: string[]
}
/** Omitted = keep both original representations; null = remove both. */
export type MetadataChanges = Partial<Record<MetadataField, string | null>>
export const metadataMode = (changes: MetadataChanges, field: MetadataField) => changes[field] === undefined ? 'keep' : changes[field] === null ? 'clear' : 'edit'
export function metadataProblem(changes: MetadataChanges): string | null {
  for (const { id, label } of METADATA_FIELDS) {
    const value = changes[id]
    if (typeof value === 'string' && (!value.length || value.length > 5000)) return `${label}: enter 1–5000 characters, or choose Clear field.`
  }
  return null
}
