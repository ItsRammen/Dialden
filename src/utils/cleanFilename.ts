/**
 * Clean Filename
 *
 * Strips file extension and replaces underscores with spaces.
 * Used for human-readable display in the dashboard and TV guide overlay.
 */

export function cleanFilename(filename: string): string {
  return filename.replace(/\.[^.]+$/, '').replace(/_/g, ' ')
}
