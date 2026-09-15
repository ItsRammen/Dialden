/** A filename hint is identity evidence, never parental approval. */
export function tmdbIdentityHint(title: string): { id: string | null; invalid: boolean } {
  const hints = [...title.matchAll(/\{tmdb[-:]([^}]*)\}/gi)]
  if (!hints.length) return { id: null, invalid: false }
  const ids = hints.map(match => match[1]!.trim())
  if (ids.some(id => !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) ||
      new Set(ids).size !== 1) return { id: null, invalid: true }
  return { id: ids[0]!, invalid: false }
}
