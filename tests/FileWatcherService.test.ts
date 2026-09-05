/**
 * Unit tests for FileWatcherService
 */

import { describe, expect, test, beforeEach, mock as bunMock } from 'bun:test'
import { mock, type MockProxy } from 'jest-mock-extended'
import { FileWatcherService } from '../src/services/FileWatcherService'
import type { FileWatcher, IFileSystem } from '../src/types'

describe('FileWatcherService', () => {
  let fs: MockProxy<IFileSystem>
  let service: FileWatcherService
  let capturedCallback:
    | ((event: 'add' | 'change' | 'remove', path: string) => void)
    | null
  let capturedErrorCallback: ((error: unknown) => void) | null

  const TEST_DIRECTORIES = ['/media/videos', '/media/interludes']
  const TEST_EXTENSIONS = ['.mp4', '.mkv'] as const

  beforeEach(() => {
    fs = mock<IFileSystem>()
    capturedCallback = null
    capturedErrorCallback = null

    // Default: directories exist
    fs.exists.mockReturnValue(true)

    // Capture the callback passed to watch()
    fs.watch.mockImplementation((_dir, callback, onError) => {
      capturedCallback = callback
      capturedErrorCallback = onError ?? null
      return { close: bunMock(() => {}) }
    })

    service = new FileWatcherService(fs, TEST_DIRECTORIES, TEST_EXTENSIONS)
  })

  test('start() watches all existing directories', () => {
    service.start()

    expect(fs.watch).toHaveBeenCalledTimes(2)
    expect(fs.watch).toHaveBeenCalledWith(
      '/media/videos',
      expect.any(Function),
      expect.any(Function)
    )
    expect(fs.watch).toHaveBeenCalledWith(
      '/media/interludes',
      expect.any(Function),
      expect.any(Function)
    )
  })

  test('start() skips non-existent directories', () => {
    // Only interludes directory exists
    fs.exists.mockImplementation((path) => path === '/media/interludes')

    service.start()

    expect(fs.watch).toHaveBeenCalledTimes(1)
    expect(fs.watch).toHaveBeenCalledWith(
      '/media/interludes',
      expect.any(Function),
      expect.any(Function)
    )
  })

  test('contains an asynchronous watcher permission failure', () => {
    const close = bunMock(() => {})
    fs.watch.mockImplementation((_dir, callback, onError) => {
      capturedCallback = callback
      capturedErrorCallback = onError ?? null
      return { close }
    })

    service.start()
    capturedErrorCallback?.(
      Object.assign(new Error('permission denied'), { code: 'EACCES' })
    )

    expect(close).toHaveBeenCalledTimes(1)
    expect(() => service.stop()).not.toThrow()
  })

  test('filters events by extension', async () => {
    const batchPromise = new Promise<string[]>((resolve) => {
      service.on('batch', resolve)
    })

    service.start()

    // Trigger events for various files
    capturedCallback?.('add', '/media/videos/show.mp4') // Should pass
    capturedCallback?.('add', '/media/videos/image.jpg') // Should be filtered
    capturedCallback?.('add', '/media/videos/outro.mkv') // Should pass
    capturedCallback?.('add', '/media/videos/NEW-EPISODE.MKV') // Case-insensitive

    // Advance timer (debounce) - use real setTimeout since service uses it internally
    await new Promise((r) => setTimeout(r, 2100))

    const batch = await batchPromise
    expect(batch).toHaveLength(3)
    expect(batch).toContain('/media/videos/show.mp4')
    expect(batch).toContain('/media/videos/outro.mkv')
    expect(batch).toContain('/media/videos/NEW-EPISODE.MKV')
  })

  test('debounces rapid events into single batch', async () => {
    let batchCount = 0
    service.on('batch', () => batchCount++)

    service.start()

    // Rapid-fire events
    capturedCallback?.('add', '/media/videos/a.mp4')
    capturedCallback?.('add', '/media/videos/b.mp4')
    capturedCallback?.('add', '/media/videos/c.mp4')

    // Wait for debounce
    await new Promise((r) => setTimeout(r, 2100))

    expect(batchCount).toBe(1) // Single batch despite 3 events
  })

  test('deduplicates same file path', async () => {
    const batchPromise = new Promise<string[]>((resolve) => {
      service.on('batch', resolve)
    })

    service.start()

    // Same file multiple times (e.g., rapid saves)
    capturedCallback?.('change', '/media/videos/show.mp4')
    capturedCallback?.('change', '/media/videos/show.mp4')
    capturedCallback?.('change', '/media/videos/show.mp4')

    await new Promise((r) => setTimeout(r, 2100))

    const batch = await batchPromise
    expect(batch).toHaveLength(1)
    expect(batch[0]).toBe('/media/videos/show.mp4')
  })

  test('stop() clears pending events', async () => {
    let batched = false
    service.on('batch', () => {
      batched = true
    })

    service.start()
    capturedCallback?.('add', '/media/videos/show.mp4')
    service.stop()

    await new Promise((r) => setTimeout(r, 2100))

    expect(batched).toBe(false) // Event was cleared, not batched
  })

  test('re-establishes a watch instead of giving up on the root', async () => {
    /* A recursive watch walks the whole tree, so one unreadable entry fails
       the watch for all of it. That used to disable change detection for a
       22,000-file library until someone restarted the container. */
    const timers: Array<{ fn: () => void; ms: number }> = []
    let attempts = 0
    let failNext = true
    let onError: ((error: unknown) => void) | undefined

    const filesystem = {
      exists: () => true,
      watch: (_dir: string, _cb: unknown, handler?: (error: unknown) => void) => {
        attempts += 1
        onError = handler as (error: unknown) => void
        return { close: () => {} }
      },
    } as never

    const service = new FileWatcherService(
      filesystem,
      ['/media/tv'],
      ['.mkv'],
      ((fn: () => void, ms: number) => {
        timers.push({ fn, ms })
        return timers.length as unknown as Timer
      }) as never,
      (() => {}) as never
    )

    service.start()
    expect(attempts).toBe(1)

    // The walk trips over one unreadable file.
    onError?.(new Error("EACCES: permission denied, open '/media/tv/one.mkv'"))
    expect(timers).toHaveLength(1)
    expect(timers[0]?.ms).toBe(5000)

    // The retry re-establishes it rather than leaving the root unwatched.
    failNext = false
    timers[0]?.fn()
    expect(attempts).toBe(2)
    expect(failNext).toBe(false)

    // A second failure backs off further rather than hammering the share.
    onError?.(new Error('EACCES again'))
    expect(timers[1]?.ms).toBe(5000)

    service.stop()
  })
})
