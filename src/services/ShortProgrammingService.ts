import type { MediaItem } from '../types'

/** Bounded best fit: full stories only, with room for each additional handover.
 * Input order provides the deterministic rotation for equally good choices. */
export function selectBlockShorts(items: readonly MediaItem[], availableSeconds: number, maximumDuration: number, maximumCount: number, handoverSeconds: number): MediaItem[] {
  const capacity = Math.max(0, Math.floor(Math.min(availableSeconds, maximumCount * (maximumDuration + handoverSeconds))))
  type Selection = { items: MediaItem[]; duration: number }
  const states = Array.from({ length: maximumCount + 1 }, () => new Map<number, Selection>())
  states[0]!.set(0, { items: [], duration: 0 })
  const seen = new Set<number>()
  for (const item of items) {
    if (seen.has(item.id) || !Number.isFinite(item.durationSeconds) || item.durationSeconds <= 0 || item.durationSeconds > maximumDuration) continue
    seen.add(item.id)
    const cost = Math.ceil(item.durationSeconds + handoverSeconds)
    if (cost > capacity) continue
    for (let count = maximumCount; count > 0; count--) {
      for (const [used, selection] of states[count - 1]!) {
        const next = used + cost
        if (next > capacity) continue
        const duration = selection.duration + item.durationSeconds
        if (duration > (states[count]!.get(next)?.duration ?? -1)) states[count]!.set(next, { items: [...selection.items, item], duration })
      }
    }
  }
  let best: Selection = { items: [], duration: 0 }
  for (const state of states) for (const selection of state.values()) if (selection.duration > best.duration) best = selection
  return best.items
}
