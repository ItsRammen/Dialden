import { describe, expect, test } from 'bun:test'
import { restartChangedChannelWorkers } from '../src/server'

describe('server channel reconciliation', () => {
  test('invalidates every changed worker record including warm and idle channels', async () => {
    const restarted: Array<{ channelId: string; reason: string }> = []
    const workers = {
      listStates: () => [
        { channelId: 'warm-channel', viewerCount: 0, status: 'idle' },
        { channelId: 'live-channel', viewerCount: 2, status: 'live' },
        { channelId: 'unchanged-channel', viewerCount: 1, status: 'live' },
      ],
      restart: async (channelId: string, reason: string) => {
        restarted.push({ channelId, reason })
        return null
      },
    } as unknown as Parameters<typeof restartChangedChannelWorkers>[1]

    await restartChangedChannelWorkers(
      ['warm-channel', 'live-channel'],
      workers
    )

    expect(restarted).toEqual([
      {
        channelId: 'warm-channel',
        reason: 'Automated channel lineup changed after a library scan',
      },
      {
        channelId: 'live-channel',
        reason: 'Automated channel lineup changed after a library scan',
      },
    ])
  })
})
