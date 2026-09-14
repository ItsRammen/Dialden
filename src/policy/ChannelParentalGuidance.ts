/** General PG content requires a deliberate channel choice, independently of library approval. */
export function isGeneralParentalGuidance(certification: string | null | undefined): boolean {
  return ['PG', 'TV-PG'].includes(certification?.trim().toUpperCase() ?? '')
}
export function channelCollectionKey(rootId: string, libraryKind: string, identityKey: string): string {
  return JSON.stringify([rootId, libraryKind, identityKey])
}
