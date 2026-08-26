/** The continuous FFmpeg muxer publishes only local rolling MPEG-TS segments. */
export const CHANNEL_SEGMENT_NAME = /^segment-\d{13}\.ts$/i

export interface ParsedHlsMediaPlaylist {
  readonly wellFormed: boolean
  readonly segmentUris: readonly string[]
}

/**
 * Parses complete media entries without accepting a URI that was observed
 * before its EXTINF line (or a final EXTINF whose in-place rewrite was torn).
 */
export function parseHlsMediaPlaylist(text: string): ParsedHlsMediaPlaylist {
  if (!/^#EXTM3U(?:\r?\n|$)/.test(text)) {
    return { wellFormed: false, segmentUris: [] }
  }

  const segmentUris: string[] = []
  let awaitingSegmentUri = false
  for (const rawLine of text.split(/\r?\n/).slice(1)) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith('#EXTINF:')) {
      if (awaitingSegmentUri) {
        return { wellFormed: false, segmentUris }
      }
      const durationText = line.slice('#EXTINF:'.length).split(',', 1)[0]?.trim()
      const duration = Number(durationText)
      if (!durationText || !Number.isFinite(duration) || duration <= 0) {
        return { wellFormed: false, segmentUris }
      }
      awaitingSegmentUri = true
      continue
    }
    if (line.startsWith('#')) continue
    if (!awaitingSegmentUri) {
      return { wellFormed: false, segmentUris }
    }
    segmentUris.push(line)
    awaitingSegmentUri = false
  }

  return { wellFormed: !awaitingSegmentUri, segmentUris }
}

/** Returns the local filename only for a segment URI emitted by our muxer. */
export function localChannelSegmentName(uri: string): string | null {
  const name = uri.split(/[?#]/, 1)[0] ?? ''
  return CHANNEL_SEGMENT_NAME.test(name) ? name : null
}
