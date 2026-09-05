import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { LogoBackgroundStripper } from './LogoBackgroundStripper'

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** Stores bounded, server-controlled PNG overlays per channel. */
export class ChannelLogoStore {
  constructor(
    private readonly directory: string,
    private readonly stripper: LogoBackgroundStripper = new LogoBackgroundStripper()
  ) {}

  path(channelId: string, logoId?: string): string {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(channelId)) {
      throw new Error('Channel ID is not safe for a logo path')
    }
    if (logoId !== undefined && !/^[a-zA-Z0-9_-]{1,64}$/.test(logoId)) {
      throw new Error('Scheduled logo ID is not safe for a logo path')
    }
    return join(this.directory, `${channelId}${logoId ? `--${logoId}` : ''}.png`)
  }

  has(channelId: string, logoId?: string): boolean {
    return existsSync(this.path(channelId, logoId))
  }

  remove(channelId: string): void {
    if (!existsSync(this.directory)) return
    for (const name of readdirSync(this.directory)) {
      if (name === `${channelId}.png` || name.startsWith(`${channelId}--`)) {
        unlinkSync(join(this.directory, name))
      }
    }
  }

  variants(channelId: string): string[] {
    if (!existsSync(this.directory)) return []
    const prefix = `${channelId}--`
    return readdirSync(this.directory)
      .filter((name) => name.startsWith(prefix) && name.endsWith('.png'))
      .map((name) => name.slice(prefix.length, -4))
      .filter((id) => /^[a-zA-Z0-9_-]{1,64}$/.test(id))
      .sort()
  }

  /**
   * Stores an uploaded logo. Logos routinely arrive with their background
   * painted on -- a white card, or the editor's transparency checkerboard
   * flattened into real pixels -- which reads as a bright box against the
   * app's dark chrome. Every write goes through here, so the repair does too.
   * Pass `keepBackground` for a logo genuinely designed on a solid card.
   */
  async save(
    channelId: string,
    file: File,
    logoId?: string,
    options: { keepBackground?: boolean } = {}
  ): Promise<string> {
    if (file.size <= 0 || file.size > 5 * 1024 * 1024) {
      throw new Error('Channel logo must be a PNG no larger than 5 MB')
    }
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (
      bytes.length < 24 ||
      PNG_SIGNATURE.some((value, index) => bytes[index] !== value)
    ) {
      throw new Error('Channel logo must be a valid PNG image')
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const width = view.getUint32(16)
    const height = view.getUint32(20)
    if (width < 1 || height < 1 || width > 4096 || height > 4096) {
      throw new Error('Channel logo dimensions must be between 1 and 4096 pixels')
    }
    mkdirSync(this.directory, { recursive: true })
    const destination = this.path(channelId, logoId)
    /* Never let the repair cost an upload: anything it cannot decode or does
       not recognise as a painted background comes back untouched. */
    const stored = options.keepBackground
      ? bytes
      : (await this.stripper.strip(bytes, width, height)).bytes
    await Bun.write(destination, stored)
    return destination
  }
}
