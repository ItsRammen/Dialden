import * as path from 'node:path'
import type { Socket } from 'bun'
import type {
  IMediaPlayer,
  PlaybackStatus,
  PlayerConfig,
  LogoConfig,
  GuideData,
} from '../types'

/**
 * MPV Client
 * Controls mpv via JSON IPC over Unix Socket.
 * Implements IMediaPlayer interface.
 */
export class MpvClient implements IMediaPlayer {
  private socket: Socket<unknown> | null = null
  private connected = false
  private requestId = 0
  private pendingRequests = new Map<
    number,
    { resolve: (val: any) => void; reject: (err: Error) => void }
  >()
  private eventListeners = new Set<(event: any) => void>()

  // Config uses "ipcSocket"
  constructor(private readonly config: PlayerConfig) {}

  get isConnected(): boolean {
    return this.connected
  }

  async connect(): Promise<void> {
    const socketPath = this.config.ipcSocket
    let attempts = 0

    while (attempts < this.config.maxReconnectAttempts) {
      try {
        await this.attemptConnection(socketPath)
        console.log(`Connected to MPV at ${socketPath}`)
        return
      } catch (error) {
        attempts++
        // Silent retry for development smoothness
        await Bun.sleep(this.config.reconnectDelayMs)
      }
    }

    // In dev, we might want to auto-spawn mpv, but for now just fail
    throw new Error(`Failed to connect to MPV at ${socketPath}`)
  }

  private attemptConnection(path: string): Promise<void> {
    return new Promise((resolve, reject) => {
      Bun.connect({
        unix: path,
        socket: {
          open: (socket) => {
            this.socket = socket
            this.connected = true
            resolve()
          },
          data: (_socket, data) => {
            this.handleData(data)
          },
          close: () => {
            this.connected = false
            console.log('MPV Disconnected')
          },
          error: (_socket, error) => {
            this.connected = false
            reject(error)
          },
        },
      })
    })
  }

  private handleData(data: Buffer) {
    const lines = data.toString().split('\n')
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        if (msg.request_id) {
          const resolver = this.pendingRequests.get(msg.request_id)
          if (resolver) {
            if (msg.error && msg.error !== 'success') {
              resolver.reject(new Error(`MPV Error: ${msg.error}`))
            } else {
              resolver.resolve(msg.data)
            }
            this.pendingRequests.delete(msg.request_id)
          }
        } else if (msg.event) {
          // Handle events if needed (end-file, property-change)
        }
      } catch (e) {
        // partial JSON or ignore
      }
    }
  }

  async disconnect(): Promise<void> {
    if (this.socket) {
      this.socket.end()
      this.socket = null
    }
    this.connected = false
  }

  /**
   * Send a command to MPV
   * @param args Command arguments (e.g. ["loadfile", "video.mp4"])
   */
  private send(args: any[]): Promise<any> {
    if (!this.connected || !this.socket) {
      // Auto-reconnect logic could go here
      return Promise.reject(new Error('Not connected to MPV'))
    }

    return new Promise((resolve, reject) => {
      this.requestId++
      const req = {
        command: args,
        request_id: this.requestId,
      }
      this.pendingRequests.set(this.requestId, { resolve, reject })
      this.socket!.write(JSON.stringify(req) + '\n')
    })
  }

  async play(path: string): Promise<void> {
    // "loadfile" "path" "replace" -> stops current, plays new
    await this.send(['loadfile', path, 'replace'])
    console.log(`MPV Playing: ${path}`)
    // Ensure not paused
    await this.send(['set_property', 'pause', false])
  }

  async enqueue(path: string): Promise<void> {
    // "loadfile" "path" "append"
    await this.send(['loadfile', path, 'append'])
  }

  async clear(): Promise<void> {
    // playlist-clear retains MPV's current entry and removes future entries.
    await this.send(['playlist-clear'])
  }

  async pause(): Promise<void> {
    // Toggle pause? Or strictly pause?
    // Cycle pause to toggle state
    await this.send(['cycle', 'pause'])
  }

  async stop(): Promise<void> {
    await this.send(['stop'])
  }

  async next(): Promise<void> {
    // "playlist-next"
    await this.send(['playlist-next'])
  }

  async setLoop(enabled: boolean): Promise<void> {
    // mpv property "loop-file" or "loop-playlist"
    // Set loop-playlist property
    await this.send(['set_property', 'loop-playlist', enabled ? 'inf' : 'no'])
  }

  async getStatus(): Promise<PlaybackStatus> {
    try {
      // Get multiple properties in batch?
      // Multi-command or individual? Individual is fine for local IPC.
      const pause = await this.send(['get_property', 'pause']).catch(
        () => false
      ) // true/false
      const path = await this.send(['get_property', 'path']).catch(() => null)
      const timePos = await this.send(['get_property', 'time-pos']).catch(
        () => 0
      )
      const duration = await this.send(['get_property', 'duration']).catch(
        () => 0
      )
      const idle = await this.send(['get_property', 'idle-active']).catch(
        () => false
      )

      let state: 'playing' | 'paused' | 'stopped' = 'stopped'
      if (idle || !path) {
        state = 'stopped'
      } else if (pause) {
        state = 'paused'
      } else {
        state = 'playing'
      }

      return {
        isPlaying: state === 'playing',
        state,
        currentFile: path,
        positionSeconds: Math.floor(timePos || 0),
        durationSeconds: Math.floor(duration || 0),
      }
    } catch (e) {
      // Connection lost or error
      return {
        isPlaying: false,
        state: 'stopped',
        currentFile: null,
        positionSeconds: 0,
        durationSeconds: 0,
      }
    }
  }

  /**
   * Show TV guide overlay via tvguide.lua script.
   * MPV-specific — not part of IMediaPlayer interface.
   */
  async showGuide(data: GuideData): Promise<void> {
    try {
      await this.send(['script-message', 'show-guide', JSON.stringify(data)])
    } catch (e) {
      console.error('Failed to show TV guide overlay:', e)
    }
  }

  /**
   * Pre-compute the logo overlay and write config to disk.
   * Lua reads from /tmp/toasttv-logo.json on each file-loaded event,
   * so zero subprocesses are spawned during playback transitions.
   */
  async updateLogo(config: LogoConfig): Promise<void> {
    const fs = require('node:fs')
    const CONFIG_PATH = '/tmp/toasttv-logo.json'
    const RAW_PATH = '/tmp/toasttv-logo.raw'

    if (!config.filePath) {
      // Remove logo config so Lua stops applying it
      try { fs.unlinkSync(CONFIG_PATH) } catch { /* ignore */ }
      try { fs.unlinkSync(RAW_PATH) } catch { /* ignore */ }
      try {
        await this.send(['script-message', 'reload-logo'])
      } catch { /* Lua may not be loaded yet */ }
      return
    }

    const absPath = path.resolve(config.filePath)
    if (!fs.existsSync(absPath)) {
      console.warn(`[MpvClient] Logo file not found: ${absPath}`)
      return
    }

    const mx = config.x || 0
    const my = config.y || 0
    const position = config.position ?? 2 // Default: top-right

    // 1. Get source dimensions via ffprobe
    let width = 0
    let height = 0
    try {
      const probe = Bun.spawn([
        'ffprobe', '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height', '-of', 'csv=p=0',
        absPath,
      ])
      const probeOut = await new Response(probe.stdout).text()
      await probe.exited
      const parts = probeOut.trim().split(',')
      width = parseInt(parts[0] ?? '0', 10)
      height = parseInt(parts[1] ?? '0', 10)
    } catch (e) {
      console.error('[MpvClient] ffprobe failed for logo:', e)
      return
    }

    if (width === 0 || height === 0) {
      console.warn('[MpvClient] Could not determine logo dimensions')
      return
    }

    // 2. Cap height at 120px, preserve aspect ratio
    const maxHeight = 120
    if (height > maxHeight) {
      width = Math.round(width * (maxHeight / height))
      height = maxHeight
    }

    // 3. Convert to raw BGRA in one shot (scale + pixel format)
    try {
      const proc = Bun.spawn([
        'ffmpeg', '-y', '-v', 'error', '-i', absPath,
        '-vf', `scale=${width}:${height}`,
        '-pix_fmt', 'bgra', '-f', 'rawvideo',
        RAW_PATH,
      ])
      await proc.exited
      if (proc.exitCode !== 0) {
        console.warn(`[MpvClient] ffmpeg raw conversion failed (code ${proc.exitCode})`)
        return
      }
    } catch (e) {
      console.error('[MpvClient] Failed to convert logo to raw BGRA:', e)
      return
    }

    // 4. Write config JSON for Lua to read
    // Position values match the settings grid:
    //   0 = Top-Left, 2 = Top-Right, 6 = Bottom-Left, 8 = Bottom-Right
    const logoConfig = { rawPath: RAW_PATH, width, height, marginX: mx, marginY: my, position }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(logoConfig))
    console.log(`[MpvClient] Logo prepared: ${width}x${height} pos=${position} → ${RAW_PATH}`)

    // 5. Tell Lua to reload (may race with script loading on startup — that's OK,
    //    file-loaded will pick up the JSON file when the first video plays)
    try {
      await this.send(['script-message', 'reload-logo'])
    } catch {
      // Lua may not be loaded yet on startup — safe to ignore
    }
  }
}
