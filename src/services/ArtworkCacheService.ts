import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

export interface ArtworkResponse {
  readonly body: Uint8Array
  readonly contentType: string
  readonly cached: boolean
}

export class ArtworkCacheService {
  private readonly allowedSizes = new Set(['w185', 'w342', 'w500'])

  constructor(
    private readonly cacheDirectory: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async getTmdbArtwork(
    size: string,
    providerPath: string
  ): Promise<ArtworkResponse | null> {
    if (!this.allowedSizes.has(size)) return null
    const filename = basename(providerPath.replace(/\\/g, '/'))
    if (
      !/^[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp)$/i.test(filename) ||
      providerPath.includes('..')
    ) {
      return null
    }

    await mkdir(this.cacheDirectory, { recursive: true })
    const cachePath = join(this.cacheDirectory, `${size}-${filename}`)
    const contentType = mimeType(filename)
    try {
      return { body: await readFile(cachePath), contentType, cached: true }
    } catch {
      // Cache miss; fetch the provider-sized image once and retain it locally.
    }

    const response = await this.fetchImpl(
      `https://image.tmdb.org/t/p/${size}/${encodeURIComponent(filename)}`,
      { headers: { Accept: 'image/avif,image/webp,image/*' } }
    )
    if (!response.ok) return null
    const body = new Uint8Array(await response.arrayBuffer())
    if (body.byteLength === 0 || body.byteLength > 10 * 1024 * 1024) return null
    await writeFile(cachePath, body)
    return {
      body,
      contentType: response.headers.get('Content-Type') ?? contentType,
      cached: false,
    }
  }
}

function mimeType(filename: string): string {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.webp')) return 'image/webp'
  return 'image/jpeg'
}
