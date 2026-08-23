import type {
  GuideData,
  IMediaPlayer,
  LogoConfig,
  PlaybackStatus,
} from '../types'

/**
 * Temporary media-player adapter for server-only deployments.
 *
 * The management server still depends on PlaybackService while playback is
 * being moved to remote clients. This adapter keeps that legacy dependency
 * bootable without pretending that Docker owns a local display device.
 */
export class DisabledMediaPlayer implements IMediaPlayer {
  get isConnected(): boolean {
    return false
  }

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {}

  async play(_path: string): Promise<void> {}

  async enqueue(_path: string): Promise<void> {}

  async clear(): Promise<void> {}

  async pause(): Promise<void> {}

  async stop(): Promise<void> {}

  async next(): Promise<void> {}

  async setLoop(_enabled: boolean): Promise<void> {}

  async getStatus(): Promise<PlaybackStatus> {
    return {
      isPlaying: false,
      state: 'stopped',
      currentFile: null,
      positionSeconds: 0,
      durationSeconds: 0,
    }
  }

  async updateLogo(_config: LogoConfig): Promise<void> {}

  async showGuide(_data: GuideData): Promise<void> {}
}
