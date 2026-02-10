import { describe, expect, it } from 'bun:test'
import { cleanFilename } from '../src/utils/cleanFilename'

describe('cleanFilename', () => {
  it('strips extension and replaces underscores', () => {
    expect(cleanFilename('penny_and_chip.mp4')).toBe('penny and chip')
  })

  it('handles mkv extension', () => {
    expect(cleanFilename('silly_sausages.mkv')).toBe('silly sausages')
  })

  it('handles multiple dots — only removes last extension', () => {
    expect(cleanFilename('v2.0.final.mp4')).toBe('v2.0.final')
  })

  it('handles filenames with no extension', () => {
    expect(cleanFilename('no_extension')).toBe('no extension')
  })

  it('handles filenames with spaces already', () => {
    expect(cleanFilename('already spaced.mp4')).toBe('already spaced')
  })

  it('handles empty string', () => {
    expect(cleanFilename('')).toBe('')
  })

  it('handles filename with only extension', () => {
    expect(cleanFilename('.mp4')).toBe('')
  })
})
