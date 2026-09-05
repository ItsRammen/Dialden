import { lstat, mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import type { MediaItem } from '../types'
import type { MediaService } from './MediaService'
import { buildBumperArgs } from './bumpers/renderSpec'
import type { BumperKind, BumperText } from './bumpers/types'
import {
  buildStationAssetFilename,
  looksLikeStationAssetFilename,
  parseStationAssetFilename,
  type StationAssetConfiguration,
  type StationAssetDescriptor,
  type StationAssetKind,
} from './StationAssetService'

export type BumperScanStatus = 'recognized' | 'invalid' | 'legacy'

export interface BumperScanItem {
  readonly media: MediaItem
  readonly status: BumperScanStatus
  readonly descriptor: StationAssetDescriptor | null
  readonly issues: readonly string[]
}

export interface BumperScanResult {
  readonly items: readonly BumperScanItem[]
  readonly recognized: number
  readonly invalid: number
  readonly legacy: number
  readonly playable: number
}

type BumperMediaLibrary = Pick<
  MediaService,
  | 'getAll'
  | 'getById'
  | 'getByPath'
  | 'getMediaDirectory'
  | 'rescan'
  | 'updateType'
  | 'updatePlaybackOverride'
>

export interface BumperDesign {
  readonly background: string
  readonly foreground: string
  readonly accent: string
}

export type BumperRenderRunner = (
  arguments_: readonly string[]
) => Promise<{ code: number; stderr?: string }>

export interface BumperAdministrationOptions {
  readonly ffmpegPath?: string
  readonly fontFile?: string
  readonly render?: BumperRenderRunner
}

const UPLOAD_EXTENSIONS = new Set(['.mp4', '.mkv', '.avi', '.mov', '.webm'])

export class BumperAdministrationService {
  constructor(
    private readonly media: BumperMediaLibrary,
    private readonly writable: boolean,
    private readonly options: BumperAdministrationOptions = {}
  ) {}

  async scan(refresh = false): Promise<BumperScanResult> {
    if (refresh) await this.media.rescan()
    const candidates = (await this.media.getAll())
      .filter(isBumperCandidate)
      .map(scanItem)
      .sort(
        (left, right) =>
          statusOrder(left.status) - statusOrder(right.status) ||
          left.media.filename.localeCompare(right.media.filename, 'en-US')
      )
    return {
      items: candidates,
      recognized: candidates.filter((item) => item.status === 'recognized').length,
      invalid: candidates.filter((item) => item.status === 'invalid').length,
      legacy: candidates.filter((item) => item.status === 'legacy').length,
      playable: candidates.filter((item) => item.media.playbackEnabled === true).length,
    }
  }

  async preview(
    id: number,
    configuration: StationAssetConfiguration
  ): Promise<{ item: MediaItem; filename: string }> {
    const item = await this.requireCandidate(id)
    return {
      item,
      filename: buildStationAssetFilename(configuration, extname(item.filename)),
    }
  }

  async configure(
    id: number,
    configuration: StationAssetConfiguration,
    playback: 'allow' | 'block' | 'policy'
  ): Promise<MediaItem> {
    if (!this.writable) throw new Error('The Station Assets library is read-only')
    const { item, filename } = await this.preview(id, configuration)
    const originalPath = resolve(item.path)
    const root = this.stationAssetsRoot()
    if (originalPath !== root && !originalPath.startsWith(`${root}${sep}`)) {
      throw new Error('Only files in the Station Assets library can be changed')
    }
    const targetPath = resolve(dirname(originalPath), filename)
    if (dirname(targetPath) !== dirname(originalPath) || basename(targetPath) !== filename) {
      throw new Error('The generated filename is not safe')
    }

    let moved = false
    if (targetPath !== originalPath) {
      const sourceStat = await lstat(originalPath)
      if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
        throw new Error('Only regular media files can be renamed')
      }
      try {
        await lstat(targetPath)
        throw new Error('A file with the generated name already exists')
      } catch (error) {
        if (!isMissingFile(error)) throw error
      }
      await rename(originalPath, targetPath)
      moved = true
    }

    try {
      await this.media.rescan()
      const configured = await this.media.getByPath(targetPath)
      if (!configured) throw new Error('The renamed asset was not indexed')
      await this.media.updateType(configured.id, 'interlude')
      await this.media.updatePlaybackOverride(
        configured.id,
        playback === 'policy' ? null : playback === 'allow'
      )
      return (await this.media.getById(configured.id)) ?? configured
    } catch (error) {
      if (moved) {
        try {
          await rename(targetPath, originalPath)
          await this.media.rescan()
        } catch {
          // Preserve the original error. A following scan will expose either path.
        }
      }
      throw error
    }
  }

  async upload(
    originalFilename: string,
    bytes: Uint8Array,
    configuration: StationAssetConfiguration,
    playback: 'allow' | 'block' | 'policy'
  ): Promise<MediaItem> {
    if (!this.writable) throw new Error('The Station Assets library is read-only')
    if (bytes.byteLength === 0) throw new Error('The uploaded file is empty')
    const extension = extname(basename(originalFilename)).toLowerCase()
    if (!UPLOAD_EXTENSIONS.has(extension)) {
      throw new Error('Upload an MP4, MKV, AVI, MOV, or WebM video')
    }
    const destination = await this.availableDestination(configuration, extension)
    await mkdir(dirname(destination.path), { recursive: true })
    let created = false
    try {
      await writeFile(destination.path, bytes, { flag: 'wx' })
      created = true
      return await this.indexAndConfigure(destination.path, playback)
    } catch (error) {
      if (created) {
        await unlink(destination.path).catch(() => {})
        await this.media.rescan().catch(() => {})
      }
      throw error
    }
  }

  async generate(
    configuration: StationAssetConfiguration,
    design: BumperDesign,
    playback: 'allow' | 'block' | 'policy'
  ): Promise<MediaItem> {
    if (!this.writable) throw new Error('The Station Assets library is read-only')
    if (!this.options.render) throw new Error('Bumper rendering is unavailable')
    if (
      !Number.isSafeInteger(configuration.targetSeconds) ||
      (configuration.targetSeconds ?? 0) < 1 ||
      (configuration.targetSeconds ?? 0) > 60
    ) {
      throw new Error('Generated bumpers must be between 1 and 60 seconds')
    }
    const destination = await this.availableDestination(configuration, '.mp4')
    await mkdir(dirname(destination.path), { recursive: true })
    // Reserve the selected variant atomically. FFmpeg may use -y only because
    // this process owns the placeholder; another intake sees it as occupied.
    await writeFile(destination.path, new Uint8Array(), { flag: 'wx' })
    try {
      const kind = generatedKind(configuration.kind)
      const text = generatedText(configuration)
      const fontFile = await this.bumperFontFile()
      const arguments_ = [
        this.options.ffmpegPath ?? 'ffmpeg',
        ...buildBumperArgs(kind, text, {
          width: 1920,
          height: 1080,
          durationSeconds: configuration.targetSeconds as number,
          fontFile,
          background: ffmpegColour(design.background, 'Background'),
          foreground: ffmpegColour(design.foreground, 'Foreground'),
          accent: ffmpegColour(design.accent, 'Accent'),
          outputPath: destination.path,
        }),
      ]
      const result = await this.options.render(arguments_)
      if (result.code !== 0) {
        throw new Error(
          `FFmpeg could not render the bumper${result.stderr ? `: ${bounded(result.stderr)}` : ''}`
        )
      }
      return await this.indexAndConfigure(destination.path, playback)
    } catch (error) {
      await unlink(destination.path).catch(() => {})
      await this.media.rescan().catch(() => {})
      throw error
    }
  }

  private async requireCandidate(id: number): Promise<MediaItem> {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid media ID')
    const item = await this.media.getById(id)
    if (!item) throw new Error('Bumper asset not found')
    if (!isBumperCandidate(item)) {
      throw new Error('Only scanned station assets can be configured here')
    }
    return item
  }

  private async availableDestination(
    configuration: StationAssetConfiguration,
    extension: string
  ): Promise<{ path: string; configuration: StationAssetConfiguration }> {
    const station = stationDirectory(configuration.station)
    const root = this.stationAssetsRoot()
    const directory = resolve(root, station, categoryDirectory(configuration.kind))
    if (!directory.startsWith(`${root}/`)) throw new Error('Invalid station destination')
    const requestedVariant = configuration.variant ?? 1
    for (let variant = requestedVariant; variant <= 999; variant++) {
      const candidateConfiguration = { ...configuration, variant }
      const filename = buildStationAssetFilename(candidateConfiguration, extension)
      const path = join(directory, filename)
      try {
        await lstat(path)
      } catch (error) {
        if (isMissingFile(error)) return { path, configuration: candidateConfiguration }
        throw error
      }
    }
    throw new Error('No unused variant number is available')
  }

  private stationAssetsRoot(): string {
    return resolve(this.media.getMediaDirectory(), 'interludes')
  }

  private async indexAndConfigure(
    path: string,
    playback: 'allow' | 'block' | 'policy'
  ): Promise<MediaItem> {
    await this.media.rescan()
    const indexed = await this.media.getByPath(path)
    if (!indexed) throw new Error('The new bumper was not indexed')
    await this.media.updateType(indexed.id, 'interlude')
    await this.media.updatePlaybackOverride(
      indexed.id,
      playback === 'policy' ? null : playback === 'allow'
    )
    return (await this.media.getById(indexed.id)) ?? indexed
  }

  private async bumperFontFile(): Promise<string> {
    const candidates = this.options.fontFile
      ? [this.options.fontFile]
      : [
          '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
          '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf',
          '/usr/share/fonts/noto/NotoSans-Bold.ttf',
          '/usr/share/fonts/noto/NotoSans-Regular.ttf',
        ]
    for (const candidate of candidates) {
      try {
        if ((await lstat(candidate)).isFile()) return candidate
      } catch {
        // Try the next common system font location.
      }
    }
    throw new Error('No usable TrueType font was found for bumper rendering')
  }
}

function isBumperCandidate(item: MediaItem): boolean {
  return (
    item.mediaType !== 'video' ||
    item.isInterlude === true ||
    looksLikeStationAssetFilename(item.filename) ||
    /(?:bumper|ident|interlude|filler|standby|up[ ._-]*next)/iu.test(item.filename)
  )
}

function scanItem(media: MediaItem): BumperScanItem {
  const descriptor = parseStationAssetFilename(media.filename)
  const status: BumperScanStatus = descriptor
    ? 'recognized'
    : looksLikeStationAssetFilename(media.filename)
      ? 'invalid'
      : 'legacy'
  const issues: string[] = []
  if (status === 'invalid') issues.push('Structured filename does not match the contract')
  if (status === 'legacy') issues.push('No station or show matching information')
  if (media.mediaType !== 'interlude' && media.isInterlude !== true) {
    issues.push('Not marked as an interlude')
  }
  if (media.rootAvailable !== true) issues.push('Library root is unavailable')
  if (media.durationSeconds <= 0) issues.push('No valid probed duration')
  if (media.playbackEnabled !== true) issues.push('Not approved for playback')
  if (
    descriptor?.targetSeconds !== undefined &&
    media.durationSeconds > 0 &&
    Math.abs(descriptor.targetSeconds - media.durationSeconds) > 1
  ) {
    issues.push(
      `Filename targets ${descriptor.targetSeconds}s; probed duration is ${Math.round(media.durationSeconds)}s`
    )
  }
  return { media, status, descriptor, issues }
}

function statusOrder(status: BumperScanStatus): number {
  return status === 'invalid' ? 0 : status === 'legacy' ? 1 : 2
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}

function categoryDirectory(kind: StationAssetKind): string {
  if (kind.startsWith('bumper-')) return `bumpers/${kind.replace('bumper-', '')}`
  if (kind === 'ident-general') return 'idents'
  if (kind === 'filler-general') return 'fillers'
  return 'standby'
}

function stationDirectory(value: string): string {
  const station = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!station) throw new Error('Station is required')
  return station
}

function generatedKind(kind: StationAssetKind): BumperKind {
  return kind === 'bumper-now-next'
    ? 'now-next'
    : kind === 'bumper-more' || kind === 'bumper-up-next'
      ? 'up-next'
      : 'ident'
}

function generatedText(configuration: StationAssetConfiguration): BumperText {
  if (configuration.kind === 'bumper-more') {
    return { eyebrow: 'More', headline: configuration.show ?? '' }
  }
  if (configuration.kind === 'bumper-up-next') {
    return { eyebrow: 'Up next', headline: configuration.next ?? '' }
  }
  if (configuration.kind === 'bumper-now-next') {
    return {
      eyebrow: 'Now',
      headline: configuration.now ?? '',
      support: `Up next: ${configuration.next ?? ''}`,
    }
  }
  if (configuration.kind === 'filler-general') {
    return { eyebrow: 'Stay tuned', headline: configuration.station }
  }
  if (configuration.kind === 'standby-loop') {
    return { eyebrow: 'We will be right back', headline: configuration.station }
  }
  return { eyebrow: 'You are watching', headline: configuration.station }
}

function ffmpegColour(value: string, label: string): string {
  if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`${label} must be a hex colour`)
  return `0x${value.slice(1).toLowerCase()}`
}

function bounded(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 300)
}
