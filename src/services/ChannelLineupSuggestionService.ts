import type { StationCollectionOption } from './StationAutomationService'

export interface ChannelLineupSuggestionRequest {
  readonly goal: string
  readonly collections: readonly StationCollectionOption[]
}

export interface ChannelLineupSuggestion {
  readonly name: string
  readonly rationale: string
  readonly collectionIds: readonly number[]
}

export interface ChannelLineupSuggestionService {
  suggestChannelLineup(
    request: ChannelLineupSuggestionRequest,
    signal?: AbortSignal
  ): Promise<ChannelLineupSuggestion>
}

export function parseChannelLineupSuggestion(
  content: string,
  request: ChannelLineupSuggestionRequest
): ChannelLineupSuggestion {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new Error('AI channel suggestion was not valid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('AI channel suggestion was not an object')
  }
  const value = parsed as Record<string, unknown>
  if (
    Object.keys(value).some(
      (key) => !['name', 'rationale', 'collectionIds'].includes(key)
    )
  ) {
    throw new Error('AI channel suggestion contained unsupported fields')
  }
  const name = typeof value.name === 'string' ? value.name.trim() : ''
  const rationale =
    typeof value.rationale === 'string' ? value.rationale.trim() : ''
  if (!name || name.length > 100 || !rationale || rationale.length > 600) {
    throw new Error('AI channel suggestion needs a concise name and rationale')
  }
  if (!Array.isArray(value.collectionIds)) {
    throw new Error('AI channel suggestion did not include a title selection')
  }
  const ids = value.collectionIds
  if (
    ids.length === 0 ||
    ids.length > 60 ||
    ids.some((id) => !Number.isInteger(id) || (id as number) <= 0)
  ) {
    throw new Error('AI channel suggestion returned invalid collection IDs')
  }
  const unique = new Set(ids as number[])
  if (unique.size !== ids.length) {
    throw new Error('AI channel suggestion returned duplicate collection IDs')
  }
  const allowed = new Set(request.collections.map((collection) => collection.id))
  if ([...unique].some((id) => !allowed.has(id))) {
    throw new Error('AI channel suggestion selected a title outside the approved catalog')
  }
  return { name, rationale, collectionIds: [...unique] }
}
