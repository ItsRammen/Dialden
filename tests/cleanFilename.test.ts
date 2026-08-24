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

  it('removes Sonarr quality and provider ID blocks', () => {
    expect(
      cleanFilename(
        "Franklin's Gloomy Day + Franklin Tells Time [SDTV 10bit AV1 AAC 2 0 Sonarr]{imdb-tt0203254}{tvdb-78150}.mkv"
      )
    ).toBe("Franklin's Gloomy Day + Franklin Tells Time")
  })

  it('removes bare WEB-DL and resolution suffixes from episode titles', () => {
    expect(
      cleanFilename("Ryan's Kick-Flipping Playdate-WEB-DL-1080p.mkv")
    ).toBe("Ryan's Kick-Flipping Playdate")
    expect(cleanFilename("Ryan's Mystery Playdate - 1080p.mkv")).toBe(
      "Ryan's Mystery Playdate"
    )
  })

  it('preserves legitimate numeric and hyphenated titles', () => {
    expect(cleanFilename('Room 104.mkv')).toBe('Room 104')
    expect(cleanFilename('Catch-22.mkv')).toBe('Catch-22')
  })
})
