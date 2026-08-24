import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createChannelStreamController } from '../src/controllers/ChannelStreamController'

describe('ChannelStreamController', () => {
  let outputRoot: string
  let touches: Array<{ channelId: string; clientId: string }>

  beforeEach(() => {
    outputRoot = mkdtempSync(join(tmpdir(), 'toasttv-channel-stream-'))
    mkdirSync(join(outputRoot, 'kids', 'live'), { recursive: true })
    writeFileSync(
      join(outputRoot, 'kids', 'live', 'index.m3u8'),
      '#EXTM3U\n#EXT-X-VERSION:6\n'
    )
    writeFileSync(
      join(outputRoot, 'kids', 'live', 'segment-0000000000001.ts'),
      'segment'
    )
    touches = []
  })

  afterEach(() => rmSync(outputRoot, { recursive: true, force: true }))

  function app() {
    return createChannelStreamController({
      channels: {
        list: () => ({
          serverTime: new Date(0).toISOString(),
          serverTimeMs: 0,
          channels: [
            {
              id: 'kids',
              name: 'Kids',
              enabled: true,
              timezone: 'UTC',
              onAir: true,
              manuallyOffAir: false,
            },
          ],
        }),
      },
      workers: {
        touch: async (channelId, clientId) => {
          touches.push({ channelId, clientId })
          return {} as never
        },
        getState: () => null,
      },
      outputRoot,
    })
  }

  test('renews one named viewer lease and serves the live playlist', async () => {
    const response = await app().request(
      '/api/v1/channels/kids/live/index.m3u8?clientId=living-room-tv'
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toContain(
      'application/vnd.apple.mpegurl'
    )
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.text()).toContain('#EXTM3U')
    expect(touches).toEqual([
      { channelId: 'kids', clientId: 'living-room-tv' },
    ])
  })

  test('serves immutable segments without inflating viewer leases', async () => {
    const response = await app().request(
      '/api/v1/channels/kids/live/segment-0000000000001.ts'
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toContain('video/mp2t')
    expect(await response.text()).toBe('segment')
    expect(touches).toEqual([])
  })

  test('rejects unknown channels and unsafe segment names', async () => {
    expect(
      (
        await app().request(
          '/api/v1/channels/missing/live/index.m3u8?clientId=tv'
        )
      ).status
    ).toBe(404)
    expect(
      (await app().request('/api/v1/channels/kids/live/..%2Fconfig.json')).status
    ).toBe(404)
  })
})
