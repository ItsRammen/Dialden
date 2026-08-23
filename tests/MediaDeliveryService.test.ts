import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mock, type MockProxy } from 'jest-mock-extended'
import type { IMediaRepository } from '../src/repositories/IMediaRepository'
import { MediaDeliveryService } from '../src/services/MediaDeliveryService'
import type { MediaItem, MediaRootConfig } from '../src/types'

function mediaItem(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: 7,
    path: 'Z:/untrusted/catalog/path.mp4',
    filename: 'episode.mp4',
    durationSeconds: 120,
    isInterlude: false,
    mediaType: 'video',
    dateStart: null,
    dateEnd: null,
    codec: 'h264',
    width: 1920,
    height: 1080,
    warning: null,
    mtime: null,
    compatibility: 'compatible',
    rootId: 'tv',
    relativePath: 'Bluey/episode.mp4',
    rootAvailable: true,
    playbackEnabled: true,
    ...overrides,
  }
}

describe('MediaDeliveryService', () => {
  let tempDirectory: string
  let rootDirectory: string
  let outsideDirectory: string
  let repository: MockProxy<IMediaRepository>
  let roots: MediaRootConfig[]

  beforeEach(() => {
    tempDirectory = mkdtempSync(join(tmpdir(), 'toasttv-media-delivery-'))
    rootDirectory = join(tempDirectory, 'root')
    outsideDirectory = join(tempDirectory, 'outside')
    mkdirSync(join(rootDirectory, 'Bluey'), { recursive: true })
    mkdirSync(outsideDirectory, { recursive: true })
    writeFileSync(join(rootDirectory, 'Bluey', 'episode.mp4'), '0123456789')
    writeFileSync(join(outsideDirectory, 'secret.mp4'), 'not for delivery')

    roots = [{ id: 'tv', directory: rootDirectory, kind: 'tv' }]
    repository = mock<IMediaRepository>()
    repository.getById.mockResolvedValue(mediaItem())
  })

  afterEach(() => {
    rmSync(tempDirectory, { recursive: true, force: true })
  })

  test('resolves an eligible file through its configured root and relative locator', async () => {
    const service = new MediaDeliveryService(repository, roots)

    const file = await service.resolve(7)

    expect(repository.getById).toHaveBeenCalledWith(7)
    expect(file).not.toBeNull()
    expect(file?.path).toBe(
      realpathSync(join(rootDirectory, 'Bluey', 'episode.mp4'))
    )
    expect(file?.path).not.toContain('untrusted')
    expect(file?.size).toBe(10)
    expect(file?.mimeType).toBe('video/mp4')
    expect(file?.lastModified).toBeInstanceOf(Date)
  })

  test.each([
    '../outside/secret.mp4',
    'Bluey/../../outside/secret.mp4',
    'Bluey/../episode.mp4',
    './Bluey/episode.mp4',
    '/Bluey/episode.mp4',
    'C:/Bluey/episode.mp4',
    'Bluey\\episode.mp4',
    'Bluey//episode.mp4',
    'Bluey/',
  ])('rejects unsafe relative locator %s', async (relativePath) => {
    repository.getById.mockResolvedValue(mediaItem({ relativePath }))
    const service = new MediaDeliveryService(repository, roots)

    expect(await service.resolve(7)).toBeNull()
  })

  test('rejects a symlink or junction that resolves outside the configured root', async () => {
    const link = join(rootDirectory, 'escape')
    try {
      symlinkSync(outsideDirectory, link, 'junction')
    } catch {
      // Some Windows policies disallow creating links for non-elevated users.
      // The lexical traversal cases above still exercise the fail-closed path.
      return
    }
    repository.getById.mockResolvedValue(
      mediaItem({ relativePath: 'escape/secret.mp4' })
    )
    const service = new MediaDeliveryService(repository, roots)

    expect(await service.resolve(7)).toBeNull()
  })

  test.each([
    { mediaType: 'intro' as const },
    { isInterlude: true },
    { durationSeconds: 0 },
    { rootAvailable: false },
    { rootAvailable: undefined },
    { playbackEnabled: false },
    { playbackEnabled: undefined },
  ])('rejects ineligible catalog item %#', async (override) => {
    repository.getById.mockResolvedValue(mediaItem(override))
    const service = new MediaDeliveryService(repository, roots)

    expect(await service.resolve(7)).toBeNull()
  })

  test('fails closed for missing rows, roots, locators, files, and unsupported types', async () => {
    const service = new MediaDeliveryService(repository, roots)

    repository.getById.mockResolvedValueOnce(null)
    expect(await service.resolve(7)).toBeNull()

    repository.getById.mockResolvedValueOnce(mediaItem({ rootId: 'movies' }))
    expect(await service.resolve(7)).toBeNull()

    repository.getById.mockResolvedValueOnce(mediaItem({ relativePath: undefined }))
    expect(await service.resolve(7)).toBeNull()

    repository.getById.mockResolvedValueOnce(
      mediaItem({ relativePath: 'Bluey/missing.mp4' })
    )
    expect(await service.resolve(7)).toBeNull()

    writeFileSync(join(rootDirectory, 'Bluey', 'notes.txt'), 'text')
    repository.getById.mockResolvedValueOnce(
      mediaItem({ relativePath: 'Bluey/notes.txt' })
    )
    expect(await service.resolve(7)).toBeNull()
  })
})
