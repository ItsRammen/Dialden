import type { LibraryChannelPolicy } from '../config/library'
import { ChannelLogoStore } from './ChannelLogoStore'

// Exact network identities only; never guess a brand from partial channel names.
// Source catalog: https://github.com/tv-logo/tv-logos (network trademarks remain theirs).
const sources: Record<string, string> = {
  'cartoon-network': 'cartoon-network-us.png',
  nickelodeon: 'nickelodeon-us.png',
  'nick-jr': 'nick-jr-us.png',
  'disney-channel': 'disney-channel-us.png',
  'disney-junior': 'disney-jr-us.png',
  toonami: 'toonami-us.png',
}
export function channelIconNetwork(channel: Pick<LibraryChannelPolicy, 'name' | 'automation'>): string | undefined {
  const configured = channel.automation?.networkId
  if (configured) return sources[configured] ? configured : undefined
  const name = channel.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') .replace(/^-|-$/g, '')
  const key = name === 'nick' ? 'nickelodeon' : name === 'disney-jr' ? 'disney-junior' : name
  return sources[key] ? key : undefined
}

/** Display icons are separate from on-air branding: sourcing never enables a watermark. */
export class ChannelIconService {
  private pending = new Map<string, Promise<string | undefined>>()
  private retryAfter = new Map<string, number>()
  constructor(
    private custom: Pick<ChannelLogoStore, 'has' | 'path'>,
    private cache: Pick<ChannelLogoStore, 'has' | 'path' | 'save'>,
    private request: (url: string, init: RequestInit) => Promise<Response> = fetch,
  ) {}
  available(channel: LibraryChannelPolicy): boolean {
    return this.custom.has(channel.id) || !!channelIconNetwork(channel)
  }
  async resolve(channel: LibraryChannelPolicy): Promise<string | undefined> {
    if (this.custom.has(channel.id)) return this.custom.path(channel.id)
    const network = channelIconNetwork(channel)
    if (!network) return undefined
    if (this.cache.has(network)) return this.cache.path(network)
    if ((this.retryAfter.get(network) ?? 0) > Date.now()) return undefined
    const existing = this.pending.get(network)
    if (existing) return existing
    const task = this.download(network).finally(() => this.pending.delete(network))
    this.pending.set(network, task)
    return task
  }
  private async download(network: string): Promise<string | undefined> {
    try {
      const response = await this.request(`https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/united-states/${sources[network]}`, {
        signal: AbortSignal.timeout(8000), redirect: 'error',
      })
      if (!response.ok || !response.body) throw new Error('Logo source unavailable')
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > 5 * 1024 * 1024) throw new Error('Logo exceeds size limit')
          chunks.push(value)
        }
      } finally { await reader.cancel().catch(() => {}) }
      const file = new File(chunks, 'channel.png', { type: 'image/png' })
      return await this.cache.save(network, file)
    } catch {
      this.retryAfter.set(network, Date.now() + 60 * 60 * 1000)
      return undefined
    }
  }
}
