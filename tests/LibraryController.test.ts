/**
 * LibraryController Tests
 *
 * Verifies library management, particularly the complex coordination
 * between MediaService and ConfigService when updating media types.
 */

import { describe, expect, test, beforeEach } from 'bun:test'
import { mock, type MockProxy } from 'jest-mock-extended'
import { createLibraryController } from '../src/controllers/LibraryController'
import type { ConfigService } from '../src/services/ConfigService'
import type { MediaService } from '../src/services/MediaService'
import type { PlaylistEngine } from '../src/services/PlaylistEngine'
import { Hono } from 'hono'
import { renderLibraryContent } from '../src/templates/library'
import type { MediaItem } from '../src/types'

describe('LibraryController', () => {
  let configService: MockProxy<ConfigService>
  let mediaService: MockProxy<MediaService>
  let playlistEngine: MockProxy<PlaylistEngine>
  let app: Hono

  beforeEach(() => {
    configService = mock<ConfigService>()
    mediaService = mock<MediaService>()
    playlistEngine = mock<PlaylistEngine>()

    const controller = createLibraryController({
      config: configService,
      media: mediaService,
      playlist: playlistEngine,
    })

    app = new Hono()
    app.route('/', controller)
  })

  test('POST /api/update-type sets Intro and updates Config', async () => {
    // When setting as intro
    const formData = new FormData()
    formData.append('type', 'intro')

    const req = new Request('http://localhost/api/update-type/100', {
      method: 'POST',
      body: formData,
    })

    const response = await app.request(req)

    // It should update config to point session.introVideoId to 100
    expect(configService.update).toHaveBeenCalledWith({
      session: { introVideoId: 100 },
    })
    expect(response.headers.get('HX-Trigger')).toBe(
      'libraryEligibilityChanged'
    )
  })

  test('POST /api/update-type sets Outro and updates Config', async () => {
    const formData = new FormData()
    formData.append('type', 'outro')

    const req = new Request('http://localhost/api/update-type/200', {
      method: 'POST',
      body: formData,
    })

    await app.request(req)

    expect(configService.update).toHaveBeenCalledWith({
      session: { outroVideoId: 200 },
    })
  })

  test('POST /api/update-type sets regular Video and clears Config if needed', async () => {
    // Setup: Config thinks ID 300 is currently the Intro
    configService.get.mockResolvedValue({
      session: { introVideoId: 300 },
    } as any)

    // Request: Change ID 300 to regular 'video'
    const formData = new FormData()
    formData.append('type', 'video')

    const req = new Request('http://localhost/api/update-type/300', {
      method: 'POST',
      body: formData,
    })

    await app.request(req)

    // Should update media type
    expect(mediaService.updateType).toHaveBeenCalledWith(300, 'video')

    // AND should clear the introVideoId from config
    expect(configService.update).toHaveBeenCalledWith({
      session: { introVideoId: null },
    })
  })

  test('POST /api/rescan triggers media rescan and playlist refresh', async () => {
    mediaService.rescan.mockResolvedValue(5)

    const formData = new FormData() // empty body (triggered from settings)

    const req = new Request('http://localhost/api/rescan', {
      method: 'POST',
      body: formData,
    })

    const res = await app.request(req)

    expect(mediaService.rescan).toHaveBeenCalled()
    expect(playlistEngine.refreshCache).toHaveBeenCalled()
    expect(await res.text()).toContain('Scanned 5 files')
  })

  test('POST /api/update-type rejects unknown types and partial IDs', async () => {
    const unknown = new FormData()
    unknown.append('type', 'not-a-media-type')
    const unknownResponse = await app.request('/api/update-type/42', {
      method: 'POST',
      body: unknown,
    })
    expect(unknownResponse.status).toBe(400)

    const malformed = new FormData()
    malformed.append('type', 'video')
    const malformedResponse = await app.request('/api/update-type/42junk', {
      method: 'POST',
      body: malformed,
    })
    expect(malformedResponse.status).toBe(400)
    expect(mediaService.updateType).not.toHaveBeenCalled()
    expect(configService.update).not.toHaveBeenCalled()
  })

  test('POST playback eligibility applies a parent override and refreshes playback', async () => {
    mediaService.getById.mockResolvedValue({
      id: 42,
      path: '/media/tv/Bluey/episode.mkv',
      filename: 'episode.mkv',
      durationSeconds: 420,
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
      policyEnabled: false,
      playbackOverride: true,
      playbackEnabled: true,
    })
    const formData = new FormData()
    formData.append('mode', 'allow')

    const response = await app.request('/api/playback-eligibility/42', {
      method: 'POST',
      body: formData,
    })

    expect(response.status).toBe(200)
    expect(mediaService.updatePlaybackOverride).toHaveBeenCalledWith(42, true)
    expect(mediaService.rescan).toHaveBeenCalled()
    expect(playlistEngine.refreshCache).toHaveBeenCalled()
    expect(await response.text()).toContain('Playable')
  })

  test('Use collection decision reports the inherited result and refreshes the active file filter', async () => {
    mediaService.getById.mockResolvedValue({
      id: 42,
      path: '/media/tv/Bluey/episode.mkv',
      filename: 'episode.mkv',
      durationSeconds: 420,
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
      collectionId: 7,
      policyEnabled: true,
      playbackOverride: null,
      rootAvailable: true,
      playbackEnabled: true,
    })
    const formData = new FormData()
    formData.append('mode', 'policy')

    const response = await app.request('/api/playback-eligibility/42', {
      method: 'POST',
      body: formData,
    })

    expect(response.status).toBe(200)
    expect(mediaService.updatePlaybackOverride).toHaveBeenCalledWith(42, null)
    expect(mediaService.rescan).not.toHaveBeenCalled()
    expect(playlistEngine.refreshCache).toHaveBeenCalled()
    expect(response.headers.get('HX-Trigger')).toBe(
      'libraryEligibilityChanged'
    )
    expect(await response.text()).toContain(
      'Using collection decision: playable'
    )
  })

  test.each([
    {
      rootAvailable: false,
      durationSeconds: 420,
      expected: 'the library root is offline or has not finished scanning',
    },
    {
      rootAvailable: true,
      durationSeconds: 0,
      expected: 'the media probe has not produced a valid duration',
    },
  ])(
    'explains the technical blocker after a parent file allow ($expected)',
    async ({ rootAvailable, durationSeconds, expected }) => {
      mediaService.getById.mockResolvedValue({
        id: 42,
        path: '/media/tv/Bluey/episode.mkv',
        filename: 'episode.mkv',
        durationSeconds,
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
        collectionId: 7,
        policyEnabled: false,
        playbackOverride: true,
        rootAvailable,
        playbackEnabled: false,
      })
      const formData = new FormData()
      formData.append('mode', 'allow')

      const response = await app.request('/api/playback-eligibility/42', {
        method: 'POST',
        body: formData,
      })
      const markup = await response.text()

      expect(response.status).toBe(200)
      expect(markup).toContain('Parent allow saved')
      expect(markup).toContain(expected)
      expect(markup).not.toContain('metadata scan')
    }
  )

  test('playback eligibility rejects partial IDs before any mutation or rescan', async () => {
    const formData = new FormData()
    formData.append('mode', 'allow')

    const response = await app.request('/api/playback-eligibility/42junk', {
      method: 'POST',
      body: formData,
    })

    expect(response.status).toBe(400)
    expect(mediaService.updatePlaybackOverride).not.toHaveBeenCalled()
    expect(mediaService.rescan).not.toHaveBeenCalled()
  })

  test('update dates rejects impossible dates and partial IDs', async () => {
    const impossible = new FormData()
    impossible.append('dateStart', '02-30')
    impossible.append('dateEnd', '03-01')
    const impossibleResponse = await app.request('/api/update-dates/42', {
      method: 'POST',
      body: impossible,
    })
    expect(impossibleResponse.status).toBe(400)

    const malformed = new FormData()
    malformed.append('dateStart', '12-01')
    malformed.append('dateEnd', '12-31')
    const malformedResponse = await app.request('/api/update-dates/42junk', {
      method: 'POST',
      body: malformed,
    })
    expect(malformedResponse.status).toBe(400)
    expect(mediaService.updateDates).not.toHaveBeenCalled()
  })

  test('library markup escapes catalog/search values and encodes filter links', () => {
    const payload = '\"><script>alert(1)</script>&'
    const item: MediaItem = {
      id: 42,
      path: '/media/show.mp4',
      filename: payload,
      durationSeconds: 60,
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
      collectionTitle: payload,
      playbackEnabled: true,
    }
    const markup = renderLibraryContent({
      media: [item],
      mediaDirectory: payload,
      view: 'list',
      filter: 'all',
      search: payload,
    })

    expect(markup).not.toContain(payload)
    expect(markup).not.toContain('<script>alert(1)</script>')
    expect(markup).toContain('%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E%26')
    expect(markup).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  test('approved and blocked filters render regular library videos', () => {
    const base: MediaItem = {
      id: 1,
      path: '/media/tv/Bluey/episode.mkv',
      filename: 'Bluey episode.mkv',
      durationSeconds: 420,
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
      collectionId: 7,
      policyEnabled: true,
      playbackOverride: null,
      playbackEnabled: true,
    }
    const approved = renderLibraryContent({
      media: [base, { ...base, id: 2, filename: 'Blocked episode.mkv', playbackEnabled: false }],
      mediaDirectory: '/media',
      view: 'list',
      filter: 'approved',
      search: '',
    })
    const blocked = renderLibraryContent({
      media: [base, { ...base, id: 2, filename: 'Blocked episode.mkv', playbackEnabled: false }],
      mediaDirectory: '/media',
      view: 'list',
      filter: 'blocked',
      search: '',
    })
    const emptyBlocked = renderLibraryContent({
      media: [],
      mediaDirectory: '/media',
      view: 'list',
      filter: 'blocked',
      search: '',
      totalCount: 0,
    })

    expect(approved).toContain('Playable files')
    expect(approved).toContain('Bluey episode.mkv')
    expect(approved).toContain(
      'Use collection decision — allows scheduling'
    )
    expect(approved).not.toContain('Blocked episode.mkv')
    expect(blocked).toContain('Not Scheduled')
    expect(blocked).toContain('Blocked episode.mkv')
    expect(blocked).not.toContain('No media indexed yet')
    expect(blocked).not.toContain('Bluey episode.mkv')
    expect(emptyBlocked).toContain('No files matching filter')
    expect(emptyBlocked).not.toContain('No media indexed yet')
  })

  test('Advanced Files requests a bounded page and preserves navigation filters', async () => {
    const items: MediaItem[] = Array.from({ length: 100 }, (_, index) => ({
      id: index + 101,
      path: `/media/file-${index + 101}.mp4`,
      filename: `file-${index + 101}.mp4`,
      durationSeconds: 60,
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
      playbackEnabled: true,
    }))
    configService.get.mockResolvedValue({
      session: {
        introVideoId: null,
        outroVideoId: null,
        offAirAssetId: null,
      },
    } as any)
    mediaService.getPage.mockResolvedValue({
      items,
      total: 275,
      page: 2,
      pageSize: 100,
    })
    mediaService.generateThumbnailsFor.mockResolvedValue()
    mediaService.getMediaDirectory.mockReturnValue('/media')

    const response = await app.request(
      '/library/files?view=grid&filter=videos&search=Family%20%26%20Friends&page=2'
    )
    const markup = await response.text()

    expect(response.status).toBe(200)
    expect(mediaService.getPage).toHaveBeenCalledWith({
      view: 'grid',
      filter: 'videos',
      search: 'Family & Friends',
      page: 2,
      pageSize: 100,
      prioritizedIds: [],
    })
    expect(markup).toContain('<h1>Indexed files</h1>')
    expect(markup).toContain('275 records')
    expect(markup).toContain('Showing 101–200 of 275 files · Page 2 of 3')
    expect(markup).toContain('page=1')
    expect(markup).toContain('page=3')
    expect(markup).toContain('search=Family%20%26%20Friends')
    expect(markup).toContain('>Playable</a>')
    expect(markup).toContain(
      'hx-trigger="libraryEligibilityChanged from:body"'
    )
    expect(markup).not.toContain('Kids 7')
    expect(mediaService.generateThumbnailsFor).toHaveBeenCalledWith(items)
    expect(mediaService.getAll).not.toHaveBeenCalled()

    const partial = await app.request(
      '/partials/library?view=grid&filter=videos&search=Family%20%26%20Friends&page=2'
    )
    expect(partial.headers.get('HX-Push-Url')).toBe(
      '/library/files?view=grid&filter=videos&search=Family%20%26%20Friends&page=2'
    )

    await app.request('/library/files?filter=errors')
    expect(mediaService.getPage).toHaveBeenLastCalledWith({
      view: 'list',
      filter: 'errors',
      search: '',
      page: 1,
      pageSize: 100,
      prioritizedIds: [],
    })
  })

  test('Advanced Files exposes the technical failure reason and file path', () => {
    const markup = renderLibraryContent({
      media: [
        {
          id: 1,
          path: '/media/tv/Bluey/broken-episode.mkv',
          filename: 'broken-episode.mkv',
          durationSeconds: 0,
          isInterlude: false,
          mediaType: 'video',
          dateStart: null,
          dateEnd: null,
          codec: null,
          width: null,
          height: null,
          warning: 'ffprobe returned invalid data',
          mtime: 1,
          compatibility: 'incompatible',
          playbackEnabled: false,
        },
      ],
      mediaDirectory: '/media',
      view: 'list',
      filter: 'errors',
      search: '',
    })

    expect(markup).toContain('Technical failures')
    expect(markup).toContain('ffprobe returned invalid data')
    expect(markup).toContain('/media/tv/Bluey/broken-episode.mkv')
  })

  test('POST /api/upload rejects writes when media is mounted read-only', async () => {
    const readOnlyController = createLibraryController({
      config: configService,
      media: mediaService,
      playlist: playlistEngine,
      mediaWritable: false,
    })
    const readOnlyApp = new Hono()
    readOnlyApp.route('/', readOnlyController)

    const response = await readOnlyApp.request('/api/upload', {
      method: 'POST',
    })

    expect(response.status).toBe(403)
    expect(await response.text()).toContain(
      'The media library is mounted read-only'
    )
    expect(mediaService.rescan).not.toHaveBeenCalled()
  })

  test('POST /api/upload rejects filenames that escape the media root', async () => {
    mediaService.getMediaDirectory.mockReturnValue('/media')
    const formData = new FormData()
    formData.append(
      'files',
      new File(['unsafe'], '../escape.mp4', { type: 'video/mp4' })
    )

    const response = await app.request('/api/upload', {
      method: 'POST',
      body: formData,
    })

    expect(response.status).toBe(400)
    expect(await response.text()).toContain('Invalid upload filename')
    expect(mediaService.rescan).not.toHaveBeenCalled()
  })

  test('POST /api/upload rejects multipart values that are not files', async () => {
    const formData = new FormData()
    formData.append('files', 'not-a-file')

    const response = await app.request('/api/upload', {
      method: 'POST',
      body: formData,
    })

    expect(response.status).toBe(400)
    expect(await response.text()).toContain('No valid files uploaded')
    expect(mediaService.rescan).not.toHaveBeenCalled()
  })

  test('media deletion refreshes the active paginated file catalog', async () => {
    const response = await app.request('/api/media/42', {
      method: 'DELETE',
    })

    expect(response.status).toBe(200)
    expect(mediaService.delete).toHaveBeenCalledWith(42)
    expect(response.headers.get('HX-Trigger')).toBe(
      'libraryEligibilityChanged'
    )
  })

  test('read-only mode blocks metadata deletion and hides delete controls', async () => {
    const readOnlyController = createLibraryController({
      config: configService,
      media: mediaService,
      playlist: playlistEngine,
      mediaWritable: false,
    })
    const readOnlyApp = new Hono()
    readOnlyApp.route('/', readOnlyController)

    const response = await readOnlyApp.request('/api/media/42', {
      method: 'DELETE',
    })

    expect(response.status).toBe(403)
    expect(mediaService.delete).not.toHaveBeenCalled()

    const item: MediaItem = {
      id: 42,
      path: '/media/show.mp4',
      filename: 'show.mp4',
      durationSeconds: 60,
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
    }
    const markup = renderLibraryContent({
      media: [item],
      mediaDirectory: '/media',
      mediaWritable: false,
      view: 'list',
      filter: 'all',
      search: '',
    })

    expect(markup).not.toContain('hx-delete=')
  })
})
