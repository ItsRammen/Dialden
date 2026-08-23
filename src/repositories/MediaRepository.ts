/**
 * SQLite Media Repository
 *
 * Uses Bun's built-in SQLite for zero-dependency persistence.
 * Implements IMediaRepository for dependency injection.
 */

import { Database } from 'bun:sqlite'
import type {
  MediaItem,
  MediaType,
  Compatibility,
  LibraryKind,
} from '../types'
import type { IMediaRepository, MediaItemInput } from './IMediaRepository'

// Base schema without media_type (for backwards compatibility)
const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT UNIQUE NOT NULL,
  filename TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL,
  is_interlude INTEGER NOT NULL DEFAULT 0,
  root_id TEXT NOT NULL DEFAULT 'legacy',
  relative_path TEXT NOT NULL,
  library_kind TEXT NOT NULL DEFAULT 'other',
  collection_title TEXT NOT NULL,
  policy_enabled INTEGER NOT NULL DEFAULT 1,
  playback_override INTEGER,
  root_available INTEGER NOT NULL DEFAULT 1,
  date_start TEXT,
  date_end TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_media_interlude ON media(is_interlude);
`

const MEDIA_COLUMNS = `
  id, path, filename, duration_seconds, is_interlude, media_type,
  date_start, date_end, codec, width, height, warning, mtime, compatibility,
  root_id, relative_path, library_kind, collection_title,
  policy_enabled, playback_override, root_available
`

const MEDIA_UPSERT_UPDATE = `
  filename = excluded.filename,
  duration_seconds = excluded.duration_seconds,
  is_interlude = CASE
    WHEN excluded.media_type IN ('intro', 'outro', 'offair') THEN excluded.is_interlude
    WHEN excluded.is_interlude = 1 THEN 1
    ELSE media.is_interlude
  END,
  media_type = CASE
    WHEN excluded.media_type IN ('intro', 'outro', 'offair') THEN excluded.media_type
    WHEN excluded.media_type = 'interlude' THEN 'interlude'
    ELSE media.media_type
  END,
  date_start = COALESCE(media.date_start, excluded.date_start),
  date_end = COALESCE(media.date_end, excluded.date_end),
  codec = excluded.codec,
  width = excluded.width,
  height = excluded.height,
  warning = excluded.warning,
  mtime = excluded.mtime,
  compatibility = excluded.compatibility,
  root_id = excluded.root_id,
  relative_path = excluded.relative_path,
  library_kind = excluded.library_kind,
  collection_title = excluded.collection_title,
  policy_enabled = excluded.policy_enabled
`

const MEDIA_UPSERT_SQL = `
  INSERT INTO media (
    path, filename, duration_seconds, is_interlude, media_type,
    date_start, date_end, codec, width, height, warning, mtime, compatibility,
    root_id, relative_path, library_kind, collection_title,
    policy_enabled, playback_override, root_available
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(path) DO UPDATE SET
    ${MEDIA_UPSERT_UPDATE}
  ON CONFLICT(root_id, relative_path) DO UPDATE SET
    path = excluded.path,
    ${MEDIA_UPSERT_UPDATE}
`

export class MediaRepository implements IMediaRepository {
  private db: Database | null = null

  constructor(private readonly dbPath: string) {}

  async initialize(): Promise<void> {
    this.db = new Database(this.dbPath, { create: true })

    // Create base schema first
    this.db.exec(BASE_SCHEMA)

    //Create settings table
    this.db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    `)

    // Migration: add media_type column if missing
    const columns = this.db.prepare('PRAGMA table_info(media)').all() as Array<{
      name: string
    }>
    const hasMediaType = columns.some((c) => c.name === 'media_type')

    if (!hasMediaType) {
      this.db.exec(
        `ALTER TABLE media ADD COLUMN media_type TEXT NOT NULL DEFAULT 'video'`
      )
      // Migrate existing interludes
      this.db.exec(
        `UPDATE media SET media_type = 'interlude' WHERE is_interlude = 1`
      )
      console.log('Migrated database to include media_type column')
    }

    // Phase 3 Migration: add extended metadata columns
    const hasCodec = columns.some((c) => c.name === 'codec')
    if (!hasCodec) {
      this.db.exec(`ALTER TABLE media ADD COLUMN codec TEXT`)
      this.db.exec(`ALTER TABLE media ADD COLUMN width INTEGER`)
      this.db.exec(`ALTER TABLE media ADD COLUMN height INTEGER`)
      this.db.exec(`ALTER TABLE media ADD COLUMN warning TEXT`)
      console.log('Migrated database to include extended metadata columns')
    }

    // Phase 4 Migration: add mtime column
    const hasMtime = columns.some((c) => c.name === 'mtime')
    if (!hasMtime) {
      this.db.exec(`ALTER TABLE media ADD COLUMN mtime INTEGER`)
      console.log('Migrated database to include mtime column')
    }

    // Hardware compatibility migration: add compatibility column
    const hasCompatibility = columns.some((c) => c.name === 'compatibility')
    if (!hasCompatibility) {
      this.db.exec(
        `ALTER TABLE media ADD COLUMN compatibility TEXT NOT NULL DEFAULT 'compatible'`
      )
      console.log('Migrated database to include compatibility column')
    }

    // Root-aware library identity and default-deny playback policy. Nullable
    // columns are backfilled before the stable locator index is created so
    // existing installations retain their rows and IDs.
    const hasRootId = columns.some((c) => c.name === 'root_id')
    if (!hasRootId) {
      this.db.exec(
        `ALTER TABLE media ADD COLUMN root_id TEXT NOT NULL DEFAULT 'legacy'`
      )
    }
    const hasRelativePath = columns.some((c) => c.name === 'relative_path')
    if (!hasRelativePath) {
      this.db.exec(`ALTER TABLE media ADD COLUMN relative_path TEXT`)
      this.db.exec(`UPDATE media SET relative_path = path`)
    }
    const hasLibraryKind = columns.some((c) => c.name === 'library_kind')
    if (!hasLibraryKind) {
      this.db.exec(
        `ALTER TABLE media ADD COLUMN library_kind TEXT NOT NULL DEFAULT 'other'`
      )
    }
    const hasCollectionTitle = columns.some(
      (c) => c.name === 'collection_title'
    )
    if (!hasCollectionTitle) {
      this.db.exec(`ALTER TABLE media ADD COLUMN collection_title TEXT`)
      this.db.exec(`UPDATE media SET collection_title = filename`)
    }
    const hasPolicyEnabled = columns.some((c) => c.name === 'policy_enabled')
    if (!hasPolicyEnabled) {
      this.db.exec(
        `ALTER TABLE media ADD COLUMN policy_enabled INTEGER NOT NULL DEFAULT 1`
      )
    }
    const hasPlaybackOverride = columns.some(
      (c) => c.name === 'playback_override'
    )
    if (!hasPlaybackOverride) {
      this.db.exec(`ALTER TABLE media ADD COLUMN playback_override INTEGER`)
    }
    const hasRootAvailable = columns.some((c) => c.name === 'root_available')
    if (!hasRootAvailable) {
      this.db.exec(
        `ALTER TABLE media ADD COLUMN root_available INTEGER NOT NULL DEFAULT 1`
      )
    }

    // Now create index on media_type (column guaranteed to exist)
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_media_type ON media(media_type);`
    )
    this.db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_media_locator ON media(root_id, relative_path);`
    )
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_media_playback_enabled ON media(policy_enabled, playback_override);`
    )

    console.log(`Initialized media database at ${this.dbPath}`)
  }

  async getSetting(key: string): Promise<string | null> {
    if (!this.db) throw new Error('Repository not initialized')
    const row = this.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(key) as { value: string } | null
    return row?.value ?? null
  }

  async setSetting(key: string, value: string): Promise<void> {
    if (!this.db) throw new Error('Repository not initialized')
    this.db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(key, value)
  }

  async getAllSettings(): Promise<Record<string, string>> {
    if (!this.db) throw new Error('Repository not initialized')
    const rows = this.db
      .prepare('SELECT key, value FROM settings')
      .all() as Array<{
      key: string
      value: string
    }>
    return rows.reduce(
      (acc, row) => ({ ...acc, [row.key]: row.value }),
      {} as Record<string, string>
    )
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close()
      this.db = null
    }
  }

  async getAllVideos(): Promise<MediaItem[]> {
    if (!this.db) throw new Error('Repository not initialized')

    const stmt = this.db.prepare(`
      SELECT ${MEDIA_COLUMNS}
      FROM media
      WHERE media_type = 'video'
        AND root_available = 1
        AND duration_seconds > 0
        AND COALESCE(playback_override, policy_enabled) = 1
    `)

    const rows = stmt.all() as Array<Record<string, unknown>>
    return rows.map((row) => this.rowToMediaItem(row))
  }

  async getInterludes(currentDate: string): Promise<MediaItem[]> {
    if (!this.db) throw new Error('Repository not initialized')

    // Logic handles:
    // 1. Permanent items (dates are null)
    // 2. Simple ranges (Start <= End): e.g. 03-01 to 05-31. Current must be between.
    // 3. Wrap-around ranges (Start > End): e.g. 12-01 to 02-28. Current must be >= Start OR <= End.
    // NOTE: We assume dates are stored as 'MM-DD' or 'YYYY-MM-DD'. We compare substrings.

    // SQLite substr(date, 6, 5) extracts 'MM-DD' from 'YYYY-MM-DD'.
    // If stored as 'MM-DD', we use it directly.
    // Current date passed in is YYYY-MM-DD. We extract MM-DD.

    const stmt = this.db.prepare(`
      SELECT ${MEDIA_COLUMNS}
      FROM media
      WHERE media_type = 'interlude'
        AND root_available = 1
        AND duration_seconds > 0
        AND COALESCE(playback_override, policy_enabled) = 1
        AND (
          (date_start IS NULL AND date_end IS NULL)
          OR (
             -- Case A: Simple Range (Start <= End)
             date_start <= date_end 
             AND strftime('%m-%d', ?1) BETWEEN date_start AND date_end
          )
          OR (
             -- Case B: Wrap-around Range (Start > End, e.g. Winter)
             date_start > date_end
             AND (strftime('%m-%d', ?1) >= date_start OR strftime('%m-%d', ?1) <= date_end)
          )
        )
    `)

    const rows = stmt.all(currentDate) as Array<Record<string, unknown>>
    return rows.map((row) => this.rowToMediaItem(row))
  }

  async getAll(): Promise<MediaItem[]> {
    if (!this.db) throw new Error('Repository not initialized')

    const stmt = this.db.prepare(`
      SELECT ${MEDIA_COLUMNS}
      FROM media ORDER BY filename
    `)

    const rows = stmt.all() as Array<Record<string, unknown>>
    return rows.map((row) => this.rowToMediaItem(row))
  }

  async getByType(type: MediaType): Promise<MediaItem | null> {
    if (!this.db) throw new Error('Repository not initialized')

    const stmt = this.db.prepare(`
      SELECT ${MEDIA_COLUMNS}
      FROM media WHERE media_type = ?
    `)

    const row = stmt.get(type) as Record<string, unknown> | null
    return row ? this.rowToMediaItem(row) : null
  }

  async upsertMedia(item: MediaItemInput): Promise<void> {
    if (!this.db) throw new Error('Repository not initialized')

    // On conflict:
    // 1. Always update filename and duration (file system truth)
    // 2. Special types (intro, outro, offair) detected from filename ALWAYS override.
    // 3. If file is in interlude folder (excluded.media_type = 'interlude'), force interlude.
    // 4. Otherwise, preserve existing media_type (respects user manual changes).

    // Note: We use CASE statements for selective updates.
    // AND: We use COALESCE for dates to "backfill" defaults (from indexer) without overriding user settings.

    const stmt = this.db.prepare(MEDIA_UPSERT_SQL)

    const transaction = this.db.transaction(() => {
      this.mergeLocatorCollision(item)
      stmt.run(
      item.path,
      item.filename,
      item.durationSeconds,
      item.isInterlude ? 1 : 0,
      item.mediaType,
      item.dateStart,
      item.dateEnd,
      item.codec,
      item.width,
      item.height,
      item.warning,
      item.mtime,
      item.compatibility,
      item.rootId ?? 'legacy',
      item.relativePath ?? item.path,
      item.libraryKind ?? 'other',
      item.collectionTitle ?? item.filename,
      (item.policyEnabled ?? true) ? 1 : 0,
      item.playbackOverride === null || item.playbackOverride === undefined
        ? null
        : item.playbackOverride
          ? 1
          : 0,
        (item.rootAvailable ?? true) ? 1 : 0
      )
    })
    transaction()
  }

  async deleteMedia(id: number): Promise<void> {
    if (!this.db) throw new Error('Repository not initialized')

    const stmt = this.db.prepare('DELETE FROM media WHERE id = ?')
    stmt.run(id)
  }

  async toggleInterlude(id: number, isInterlude: boolean): Promise<void> {
    if (!this.db) throw new Error('Repository not initialized')

    const stmt = this.db.prepare(
      'UPDATE media SET is_interlude = ?, media_type = ? WHERE id = ?'
    )
    stmt.run(isInterlude ? 1 : 0, isInterlude ? 'interlude' : 'video', id)
  }

  async updateMediaType(id: number, mediaType: MediaType): Promise<void> {
    if (!this.db) throw new Error('Repository not initialized')

    const isInterlude = mediaType === 'interlude'
    const stmt = this.db.prepare(
      'UPDATE media SET media_type = ?, is_interlude = ? WHERE id = ?'
    )
    stmt.run(mediaType, isInterlude ? 1 : 0, id)
  }

  async resetMediaType(mediaType: MediaType): Promise<void> {
    if (!this.db) throw new Error('Repository not initialized')

    // Reset all items of this type back to 'video'
    const stmt = this.db.prepare(
      'UPDATE media SET media_type = ?, is_interlude = 0 WHERE media_type = ?'
    )
    stmt.run('video', mediaType)
  }

  async getById(id: number): Promise<MediaItem | null> {
    if (!this.db) throw new Error('Repository not initialized')

    const stmt = this.db.prepare(`
      SELECT ${MEDIA_COLUMNS}
      FROM media WHERE id = ?
    `)
    const row = stmt.get(id) as Record<string, unknown> | null
    return row ? this.rowToMediaItem(row) : null
  }

  async getByPath(path: string): Promise<MediaItem | null> {
    if (!this.db) throw new Error('Repository not initialized')

    const stmt = this.db.prepare(`
      SELECT ${MEDIA_COLUMNS}
      FROM media WHERE path = ?
    `)
    const row = stmt.get(path) as Record<string, unknown> | null
    return row ? this.rowToMediaItem(row) : null
  }

  async updateDates(
    id: number,
    dateStart: string | null,
    dateEnd: string | null
  ): Promise<void> {
    if (!this.db) throw new Error('Repository not initialized')

    const stmt = this.db.prepare(
      'UPDATE media SET date_start = ?, date_end = ? WHERE id = ?'
    )
    stmt.run(dateStart, dateEnd, id)
  }

  async updatePlaybackOverride(
    id: number,
    enabled: boolean | null
  ): Promise<void> {
    if (!this.db) throw new Error('Repository not initialized')
    this.db
      .prepare('UPDATE media SET playback_override = ? WHERE id = ?')
      .run(enabled === null ? null : enabled ? 1 : 0, id)
  }

  async restrictPlaybackToRoots(rootIds: string[]): Promise<number> {
    if (!this.db) throw new Error('Repository not initialized')
    if (rootIds.length === 0) return 0

    const placeholders = rootIds.map(() => '?').join(',')
    const result = this.db
      .prepare(
        `UPDATE media
         SET policy_enabled = 0, root_available = 0
         WHERE root_id NOT IN (${placeholders})`
      )
      .run(...rootIds)
    return result.changes
  }

  async synchronizePlaybackPolicy(
    roots: ReadonlyArray<{
      id: string
      approvedCollections?: readonly string[]
    }>
  ): Promise<number> {
    if (!this.db) throw new Error('Repository not initialized')
    if (roots.length === 0) return 0

    const transaction = this.db.transaction(() => {
      let changed = 0
      const rootIds = roots.map((root) => root.id)
      const rootPlaceholders = rootIds.map(() => '?').join(',')
      changed += this.db!
        .prepare(
          `UPDATE media
           SET policy_enabled = 0, root_available = 0
           WHERE root_id NOT IN (${rootPlaceholders})`
        )
        .run(...rootIds).changes

      for (const root of roots) {
        // A managed root is unavailable until the current process scans it.
        // This prevents stale absolute paths from being played after a mount
        // or container-path change.
        changed += this.db!
          .prepare('UPDATE media SET root_available = 0 WHERE root_id = ?')
          .run(root.id).changes
        if (root.approvedCollections === undefined) {
          changed += this.db!
            .prepare('UPDATE media SET policy_enabled = 1 WHERE root_id = ?')
            .run(root.id).changes
          continue
        }

        // Reset first so a narrowed policy takes effect synchronously even if
        // the corresponding mount is unavailable during this startup.
        changed += this.db!
          .prepare('UPDATE media SET policy_enabled = 0 WHERE root_id = ?')
          .run(root.id).changes
        if (root.approvedCollections.length === 0) continue

        const CHUNK_SIZE = 498
        for (
          let index = 0;
          index < root.approvedCollections.length;
          index += CHUNK_SIZE
        ) {
          const chunk = root.approvedCollections.slice(
            index,
            index + CHUNK_SIZE
          )
          const placeholders = chunk.map(() => '?').join(',')
          changed += this.db!
            .prepare(
              `UPDATE media
               SET policy_enabled = 1
               WHERE root_id = ?
                 AND collection_title COLLATE NOCASE IN (${placeholders})`
            )
            .run(root.id, ...chunk).changes
        }
      }
      return changed
    })

    return transaction()
  }

  async setRootAvailable(rootId: string, available: boolean): Promise<void> {
    if (!this.db) throw new Error('Repository not initialized')
    this.db
      .prepare('UPDATE media SET root_available = ? WHERE root_id = ?')
      .run(available ? 1 : 0, rootId)
  }

  private rowToMediaItem(row: Record<string, unknown>): MediaItem {
    const mediaType = (row.media_type as MediaType) ?? 'video'
    const rawCompat = row.compatibility as string | undefined
    const compatibility =
      rawCompat === 'marginal' || rawCompat === 'incompatible'
        ? rawCompat
        : 'compatible'
    return {
      id: row.id as number,
      path: row.path as string,
      filename: row.filename as string,
      durationSeconds: row.duration_seconds as number,
      isInterlude: Boolean(row.is_interlude),
      mediaType,
      dateStart: (row.date_start as string) ?? null,
      dateEnd: (row.date_end as string) ?? null,
      codec: (row.codec as string) ?? null,
      width: (row.width as number) ?? null,
      height: (row.height as number) ?? null,
      warning: (row.warning as string) ?? null,
      mtime: (row.mtime as number) ?? null,
      compatibility,
      rootId: (row.root_id as string) ?? 'legacy',
      relativePath: (row.relative_path as string) ?? (row.path as string),
      libraryKind: this.normalizeLibraryKind(row.library_kind),
      collectionTitle:
        (row.collection_title as string) ?? (row.filename as string),
      policyEnabled: Boolean(row.policy_enabled),
      playbackOverride:
        row.playback_override === null || row.playback_override === undefined
          ? null
          : Boolean(row.playback_override),
      rootAvailable: Boolean(row.root_available ?? 1),
      playbackEnabled: Boolean(
        (row.root_available ?? 1) &&
          Number(row.duration_seconds) > 0 &&
          (row.playback_override ?? row.policy_enabled ?? 1)
      ),
    }
  }

  private normalizeLibraryKind(value: unknown): LibraryKind {
    return value === 'tv' || value === 'movie' ? value : 'other'
  }

  /**
   * A path migration can temporarily leave one legacy row owning the new
   * absolute path and another row owning the stable root-relative locator.
   * SQLite cannot resolve both unique conflicts in one UPSERT. Preserve the
   * stable-locator row and remove only the duplicate path row first.
   */
  private mergeLocatorCollision(item: MediaItemInput): void {
    if (!this.db) throw new Error('Repository not initialized')
    const rootId = item.rootId ?? 'legacy'
    const relativePath = item.relativePath ?? item.path
    const pathRow = this.db
      .prepare('SELECT id, playback_override FROM media WHERE path = ?')
      .get(item.path) as
      | { id: number; playback_override: number | null }
      | null
    const locatorRow = this.db
      .prepare(
        'SELECT id, playback_override FROM media WHERE root_id = ? AND relative_path = ?'
      )
      .get(rootId, relativePath) as
      | { id: number; playback_override: number | null }
      | null

    if (!pathRow || !locatorRow || pathRow.id === locatorRow.id) return

    // A block wins when duplicate rows disagree; otherwise retain the stable
    // locator's override, falling back to the legacy path row.
    const mergedOverride =
      pathRow.playback_override === 0 || locatorRow.playback_override === 0
        ? 0
        : locatorRow.playback_override ?? pathRow.playback_override
    this.db
      .prepare('UPDATE media SET playback_override = ? WHERE id = ?')
      .run(mergedOverride, locatorRow.id)
    this.db.prepare('DELETE FROM media WHERE id = ?').run(pathRow.id)
  }

  // --- Batch Operations ---

  async getByPaths(paths: string[]): Promise<Map<string, MediaItem>> {
    if (!this.db) throw new Error('Repository not initialized')
    const result = new Map<string, MediaItem>()
    if (paths.length === 0) return result

    // SQLite has a limit on number of parameters, chunk into batches of 500
    const CHUNK_SIZE = 500
    for (let i = 0; i < paths.length; i += CHUNK_SIZE) {
      const chunk = paths.slice(i, i + CHUNK_SIZE)
      const placeholders = chunk.map(() => '?').join(',')
      const stmt = this.db.prepare(`
        SELECT ${MEDIA_COLUMNS}
        FROM media WHERE path IN (${placeholders})
      `)
      const rows = stmt.all(...chunk) as Array<Record<string, unknown>>
      for (const row of rows) {
        const item = this.rowToMediaItem(row)
        result.set(item.path, item)
      }
    }
    return result
  }

  async getByRootRelativePaths(
    rootId: string,
    relativePaths: string[]
  ): Promise<Map<string, MediaItem>> {
    if (!this.db) throw new Error('Repository not initialized')
    const result = new Map<string, MediaItem>()
    if (relativePaths.length === 0) return result

    const CHUNK_SIZE = 499
    for (let index = 0; index < relativePaths.length; index += CHUNK_SIZE) {
      const chunk = relativePaths.slice(index, index + CHUNK_SIZE)
      const placeholders = chunk.map(() => '?').join(',')
      const rows = this.db
        .prepare(
          `SELECT ${MEDIA_COLUMNS}
           FROM media
           WHERE root_id = ? AND relative_path IN (${placeholders})`
        )
        .all(rootId, ...chunk) as Array<Record<string, unknown>>
      for (const row of rows) {
        const item = this.rowToMediaItem(row)
        result.set(item.relativePath ?? item.path, item)
      }
    }
    return result
  }

  async upsertBatch(items: MediaItemInput[]): Promise<void> {
    if (!this.db) throw new Error('Repository not initialized')
    if (items.length === 0) return

    // Use transaction for performance
    const stmt = this.db.prepare(MEDIA_UPSERT_SQL)

    const transaction = this.db.transaction(() => {
      for (const item of items) {
        this.mergeLocatorCollision(item)
        stmt.run(
          item.path,
          item.filename,
          item.durationSeconds,
          item.isInterlude ? 1 : 0,
          item.mediaType,
          item.dateStart,
          item.dateEnd,
          item.codec,
          item.width,
          item.height,
          item.warning,
          item.mtime,
          item.compatibility,
          item.rootId ?? 'legacy',
          item.relativePath ?? item.path,
          item.libraryKind ?? 'other',
          item.collectionTitle ?? item.filename,
          (item.policyEnabled ?? true) ? 1 : 0,
          item.playbackOverride === null ||
            item.playbackOverride === undefined
            ? null
            : item.playbackOverride
              ? 1
              : 0,
          (item.rootAvailable ?? true) ? 1 : 0
        )
      }
    })
    transaction()
  }

  async removeByPaths(paths: string[]): Promise<number> {
    if (!this.db) throw new Error('Repository not initialized')
    if (paths.length === 0) return 0

    let removed = 0
    const CHUNK_SIZE = 500
    for (let i = 0; i < paths.length; i += CHUNK_SIZE) {
      const chunk = paths.slice(i, i + CHUNK_SIZE)
      const placeholders = chunk.map(() => '?').join(',')
      const result = this.db
        .prepare(`DELETE FROM media WHERE path IN (${placeholders})`)
        .run(...chunk)
      removed += result.changes
    }
    return removed
  }

  async removeNotInPaths(validPaths: string[]): Promise<number> {
    if (!this.db) throw new Error('Repository not initialized')

    if (validPaths.length === 0) {
      // Remove all entries
      const countResult = this.db
        .prepare('SELECT COUNT(*) as count FROM media')
        .get() as { count: number }
      this.db.exec('DELETE FROM media')
      console.log(`Removed ${countResult.count} stale entries (no valid paths)`)
      return countResult.count
    }

    // Get all current paths in DB
    const allPaths = this.db.prepare('SELECT path FROM media').all() as Array<{
      path: string
    }>
    const validPathSet = new Set(validPaths)

    let removed = 0
    for (const { path } of allPaths) {
      if (!validPathSet.has(path)) {
        this.db.prepare('DELETE FROM media WHERE path = ?').run(path)
        console.log(`Removed stale entry: ${path}`)
        removed++
      }
    }

    if (removed > 0) {
      console.log(`Removed ${removed} stale entries from database`)
    }
    return removed
  }

  async removeNotInRootPaths(
    rootId: string,
    validRelativePaths: string[]
  ): Promise<number> {
    if (!this.db) throw new Error('Repository not initialized')

    const rows = this.db
      .prepare('SELECT id, relative_path FROM media WHERE root_id = ?')
      .all(rootId) as Array<{ id: number; relative_path: string }>
    const valid = new Set(validRelativePaths)
    const staleIds = rows
      .filter((row) => !valid.has(row.relative_path))
      .map((row) => row.id)

    if (staleIds.length === 0) return 0

    const statement = this.db.prepare('DELETE FROM media WHERE id = ?')
    const transaction = this.db.transaction(() => {
      for (const id of staleIds) statement.run(id)
    })
    transaction()

    console.log(`Removed ${staleIds.length} stale entries from root ${rootId}`)
    return staleIds.length
  }

  /**
   * Update compatibility for multiple items in a single transaction.
   * Used when hardware profile changes.
   */
  async updateCompatibilityBatch(
    updates: Array<{ id: number; compatibility: Compatibility }>
  ): Promise<number> {
    if (!this.db) throw new Error('Repository not initialized')
    if (updates.length === 0) return 0

    const stmt = this.db.prepare(
      'UPDATE media SET compatibility = ? WHERE id = ?'
    )

    let count = 0
    this.db.exec('BEGIN TRANSACTION')
    try {
      for (const { id, compatibility } of updates) {
        stmt.run(compatibility, id)
        count++
      }
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }

    return count
  }
}
