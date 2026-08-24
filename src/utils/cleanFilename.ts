/**
 * Clean Filename
 *
 * Strips file extensions and trailing release-manager metadata, then replaces
 * underscores with spaces.
 * Used for human-readable display in the dashboard and TV guide overlay.
 */

export function cleanFilename(filename: string): string {
  return cleanMediaTitle(filename.replace(/\.[^.]+$/, ''))
}

/**
 * Clean a filename-derived title without removing dots that may be meaningful
 * (for example, `v2.0.final`). Sonarr/Radarr identity tags and technical
 * quality blocks are metadata, not part of the programme title.
 */
export function cleanMediaTitle(value: string): string {
  let title = value.replace(/_/g, ' ').trim()

  // External IDs are commonly appended by Sonarr/Radarr as separate blocks.
  title = title.replace(
    /(?:\s*\{(?:imdb|tmdb|tvdb)-[^{}]+\})+\s*$/i,
    ''
  )

  // Only remove square-bracket blocks that look like release metadata. This
  // preserves legitimate titles such as "Episode [Part One]".
  title = title.replace(
    /\s*\[(?=[^\]]*(?:sonarr|radarr|sdtv|hdtv|webrip|web[ ._-]?dl|blu[ ._-]?ray|remux|av1|hevc|x26[45]|h\.?26[45]|aac|ddp?|\d{3,4}p|10bit))[^\]]+\]\s*$/i,
    ''
  )

  // Some libraries omit brackets and append a release-quality block directly
  // to the episode title (for example, `Title-WEB-DL-1080p`). Require the
  // suffix to begin with an unambiguous source or resolution token, then
  // consume only known technical tokens. This leaves ordinary numeric and
  // hyphenated titles such as `Room 104` and `Catch-22` intact.
  title = title.replace(
    /[\s._-]+(?=(?:sdtv|hdtv|webrip|web[ ._-]?dl|blu[ ._-]?ray|b[dr]rip|dvdrip|remux|\d{3,4}[pi])(?:[\s._-]|$))(?:(?:sdtv|hdtv|webrip|web[ ._-]?dl|blu[ ._-]?ray|b[dr]rip|dvdrip|remux|\d{3,4}[pi]|av1|hevc|x26[45]|h\.?26[45]|(?:8|10)bit|aac(?:[ .]?\d(?:[ .]\d)?)?|ddp?(?:[ .]?\d(?:[ .]\d)?)?|e?ac3|proper|repack)[\s._-]*)+$/i,
    ''
  )

  return title.replace(/[\s.-]+$/g, '').replace(/\s+/g, ' ').trim()
}
