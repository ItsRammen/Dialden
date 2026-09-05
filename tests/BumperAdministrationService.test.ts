import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mock } from 'jest-mock-extended'
import type { MediaItem } from '../src/types'
import type { MediaService } from '../src/services/MediaService'
import { BumperAdministrationService } from '../src/services/BumperAdministrationService'

function media(id: number, path: string, overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id,
    path,
    filename: path.split('/').at(-1) ?? path,
    durationSeconds: 8,
    isInterlude: false,
    mediaType: 'video',
    dateStart: null,
    dateEnd: null,
    codec: 'h264',
    width: 1920,
    height: 1080,
    warning: null,
    mtime: 1,
    compatibility: 'compatible',
    rootId: 'interludes',
    relativePath: path.split('/').at(-1) ?? path,
    libraryKind: 'other',
    collectionTitle: path,
    policyEnabled: false,
    playbackOverride: null,
    rootAvailable: true,
    playbackEnabled: false,
    ...overrides,
  }
}

describe('BumperAdministrationService', () => {
  const directories: string[] = []

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('scans recognized, malformed, and likely legacy assets with actionable issues', async () => {
    const library = mock<MediaService>()
    library.getAll.mockResolvedValue([
      media(1, '/media/nick__ident-general__target-08s__v01.mp4', {
        isInterlude: true,
        mediaType: 'interlude',
        playbackOverride: true,
        policyEnabled: true,
        playbackEnabled: true,
      }),
      media(2, '/media/nick__bumper-typo__v01.mp4'),
      media(3, '/media/Old Nick Bumper.mp4'),
      media(4, '/media/SpongeBob S01E01.mp4'),
    ])
    const result = await new BumperAdministrationService(library, true).scan()

    expect(result.items).toHaveLength(3)
    expect(result).toMatchObject({ recognized: 1, invalid: 1, legacy: 1, playable: 1 })
    expect(result.items[0]?.issues).toContain(
      'Structured filename does not match the contract'
    )
    expect(result.items[1]?.issues).toContain('No station or show matching information')
  })

  test('renames, marks, and approves an asset as one configuration operation', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'toasttv-bumper-admin-'))
    directories.push(directory)
    const originalPath = join(directory, 'Nick bumper old.mp4')
    writeFileSync(originalPath, 'asset')
    const original = media(10, originalPath)
    const configuredPath = join(
      directory,
      'nick__bumper-up-next__next-spongebob-squarepants-1999__target-08s__v02.mp4'
    )
    const library = mock<MediaService>()
    library.getById.mockImplementation(async (id) =>
      id === 10
        ? original
        : media(11, configuredPath)
    )
    library.rescan.mockImplementation(async () => 1)
    library.getByPath.mockImplementation(async (path) =>
      media(11, path, { filename: path.split('/').at(-1) ?? path })
    )
    const service = new BumperAdministrationService(library, true)

    const configured = await service.configure(
      10,
      {
        station: 'Nick',
        kind: 'bumper-up-next',
        next: 'SpongeBob SquarePants (1999)',
        targetSeconds: 8,
        variant: 2,
      },
      'allow'
    )

    const expectedName =
      'nick__bumper-up-next__next-spongebob-squarepants-1999__target-08s__v02.mp4'
    expect(existsSync(originalPath)).toBe(false)
    expect(existsSync(join(directory, expectedName))).toBe(true)
    expect(configured.filename).toBe(expectedName)
    expect(library.updateType).toHaveBeenCalledWith(11, 'interlude')
    expect(library.updatePlaybackOverride).toHaveBeenCalledWith(11, true)
  })

  test('previews in read-only mode but refuses to mutate the file', async () => {
    const library = mock<MediaService>()
    library.getById.mockResolvedValue(media(5, '/media/Nick ident.mp4'))
    const service = new BumperAdministrationService(library, false)
    const configuration = {
      station: 'Nick',
      kind: 'ident-general' as const,
      targetSeconds: 8,
      variant: 1,
    }

    expect((await service.preview(5, configuration)).filename).toBe(
      'nick__ident-general__target-08s__v01.mp4'
    )
    await expect(service.configure(5, configuration, 'allow')).rejects.toThrow(
      'read-only'
    )
  })

  test('uploads into the canonical folder and advances an occupied variant', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'toasttv-bumper-upload-'))
    directories.push(directory)
    const destinationDirectory = join(
      directory,
      'interludes',
      'nick',
      'idents'
    )
    const firstName = 'nick__ident-general__target-08s__v01.mp4'
    const secondName = 'nick__ident-general__target-08s__v02.mp4'
    mkdirSync(destinationDirectory, { recursive: true })
    writeFileSync(join(destinationDirectory, firstName), 'existing')
    const library = mock<MediaService>()
    library.getMediaDirectory.mockReturnValue(directory)
    library.rescan.mockResolvedValue(1)
    library.getByPath.mockImplementation(async (path) => media(21, path))
    library.getById.mockImplementation(async (id) =>
      id === 21 ? media(21, join(destinationDirectory, secondName)) : null
    )

    const result = await new BumperAdministrationService(library, true).upload(
      'My Finished Ident.MOV.mp4',
      new TextEncoder().encode('video'),
      {
        station: 'Nick',
        kind: 'ident-general',
        targetSeconds: 8,
        variant: 1,
      },
      'allow'
    )

    expect(result.filename).toBe(secondName)
    expect(existsSync(join(destinationDirectory, secondName))).toBe(true)
  })

  test('renders a designed bumper with safe FFmpeg arguments before indexing it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'toasttv-bumper-render-'))
    directories.push(directory)
    const library = mock<MediaService>()
    library.getMediaDirectory.mockReturnValue(directory)
    library.rescan.mockResolvedValue(1)
    library.getByPath.mockImplementation(async (path) => media(31, path))
    library.getById.mockImplementation(async (id) =>
      id === 31
        ? media(
            31,
            join(
              directory,
              'interludes/nick/bumpers/up-next/nick__bumper-up-next__next-spongebob-squarepants-1999__target-08s__v01.mp4'
            )
          )
        : null
    )
    let command: readonly string[] = []
    const fontFile = join(directory, 'test.ttf')
    writeFileSync(fontFile, 'font')
    const service = new BumperAdministrationService(library, true, {
      fontFile,
      render: async (arguments_) => {
        command = arguments_
        writeFileSync(arguments_.at(-1) as string, 'rendered')
        return { code: 0 }
      },
    })

    await service.generate(
      {
        station: 'Nick',
        kind: 'bumper-up-next',
        next: 'SpongeBob SquarePants (1999)',
        targetSeconds: 8,
        variant: 1,
      },
      { background: '#0b1220', foreground: '#ffffff', accent: '#4f8cff' },
      'allow'
    )

    expect(command[0]).toBe('ffmpeg')
    expect(command.join(' ')).toContain('Up next')
    expect(command.join(' ')).toContain('SpongeBob SquarePants')
    expect(command.join(' ')).toContain(`fontfile=${fontFile}`)
    expect(library.updateType).toHaveBeenCalledWith(31, 'interlude')
  })
})
