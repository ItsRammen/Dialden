import { describe, expect, test } from 'bun:test'
import { DisabledMediaPlayer } from '../src/clients/DisabledMediaPlayer'

describe('DisabledMediaPlayer', () => {
  test('reports a stable stopped state while accepting legacy player calls', async () => {
    const player = new DisabledMediaPlayer()

    await player.connect()
    await player.play('/media/example.mp4')
    await player.enqueue('/media/next.mp4')
    await player.pause()
    await player.setLoop(true)
    const status = await player.getStatus()

    expect(player.isConnected).toBe(false)
    expect(status.isPlaying).toBe(false)
    expect(status.state).toBe('stopped')
    expect(status.currentFile).toBeNull()
    expect(status.positionSeconds).toBe(0)
    expect(status.durationSeconds).toBe(0)
  })
})
