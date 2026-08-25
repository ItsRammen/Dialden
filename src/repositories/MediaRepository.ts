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
  CollectionListOptions,
  CollectionMetadataUpdate,
  EpisodeMetadataUpdate,
  CollectionUpsertInput,
  LibrarySummary,
  MediaCollection,
  MediaFileListOptions,
  MediaFilePage,
  MetadataCandidateRecord,
  MetadataMatchStatus,
  MetadataRatingStatus,
  OverrideDecision,
  PolicyDecision,
} from '../types'
import type { IMediaRepository, MediaItemInput } from './IMediaRepository'
import { parseEpisodeRange } from '../domain/CollectionIdentity'
import { resolveEffectiveDecision } from '../policy/PolicyEngine'

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
  policy_enabled INTEGER NOT NULL DEFAULT 0,
  playback_override INTEGER,
  root_available INTEGER NOT NULL DEFAULT 1,
  collection_id INTEGER,
  season_number INTEGER,
  episode_number INTEGER,
  episode_title TEXT,
  episode_metadata_title TEXT,
  episode_overview TEXT,
  episode_air_date TEXT,
  episode_still_path TEXT,
  date_start TEXT,
  date_end TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_media_interlude ON media(is_interlude);
`

const COLLECTION_SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS media_collections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  root_id TEXT NOT NULL,
  library_kind TEXT NOT NULL,
  identity_key TEXT NOT NULL,
  source_title TEXT NOT NULL,
  parsed_title TEXT NOT NULL,
  year INTEGER,
  present INTEGER NOT NULL DEFAULT 1,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  metadata_provider TEXT,
  metadata_external_id TEXT,
  metadata_status TEXT NOT NULL DEFAULT 'pending',
  metadata_locked INTEGER NOT NULL DEFAULT 0,
  metadata_title TEXT,
  metadata_original_title TEXT,
  metadata_year INTEGER,
  overview TEXT,
  poster_path TEXT,
  backdrop_path TEXT,
  genres_json TEXT NOT NULL DEFAULT '[]',
  networks_json TEXT NOT NULL DEFAULT '[]',
  studios_json TEXT NOT NULL DEFAULT '[]',
  certification TEXT,
  certification_region TEXT,
  rating_status TEXT NOT NULL DEFAULT 'missing',
  match_confidence REAL,
  metadata_candidates_json TEXT NOT NULL DEFAULT '[]',
  metadata_error TEXT,
  metadata_matched_at TEXT,
  metadata_refreshed_at TEXT,
  policy_decision TEXT NOT NULL DEFAULT 'review'
    CHECK (policy_decision IN ('allow', 'review', 'block')),
  policy_reason TEXT NOT NULL DEFAULT 'metadata_pending',
  policy_profile_id TEXT NOT NULL DEFAULT 'kids-7',
  policy_version INTEGER NOT NULL DEFAULT 1,
  policy_evaluated_at TEXT,
  parent_override TEXT
    CHECK (parent_override IS NULL OR parent_override IN ('allow', 'block')),
  override_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(root_id, library_kind, identity_key)
);

CREATE INDEX IF NOT EXISTS idx_collections_kind_title
  ON media_collections(library_kind, parsed_title);
CREATE INDEX IF NOT EXISTS idx_collections_review
  ON media_collections(present, policy_decision, parent_override);
CREATE INDEX IF NOT EXISTS idx_collections_metadata
  ON media_collections(present, metadata_status, metadata_locked);
`

const MEDIA_COLUMNS = `
  id, path, filename, duration_seconds, is_interlude, media_type,
  date_start, date_end, codec, width, height, warning, mtime, compatibility,
  has_audio, audio_codec, pixel_format,
  root_id, relative_path, library_kind, collection_title,
  policy_enabled, playback_override, root_available,
  collection_id,
  (SELECT identity_key FROM media_collections
    WHERE media_collections.id = media.collection_id) AS collection_identity_key,
  (SELECT metadata_title FROM media_collections
    WHERE media_collections.id = media.collection_id) AS collection_metadata_title,
  (SELECT genres_json FROM media_collections
    WHERE media_collections.id = media.collection_id) AS collection_genres_json,
  season_number, episode_number, episode_title,
  episode_metadata_title, episode_overview, episode_air_date, episode_still_path
`

/** One fail-closed expression shared by every collection query/projection. */
const COLLECTION_EFFECTIVE_DECISION_SQL = `CASE
  WHEN collection.parent_override IS NULL THEN CASE
    WHEN collection.policy_decision IN ('allow', 'review', 'block')
      THEN collection.policy_decision
    ELSE 'review'
  END
  WHEN collection.parent_override IN ('allow', 'block')
    THEN collection.parent_override
  ELSE 'review'
END`

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
  has_audio = COALESCE(excluded.has_audio, media.has_audio),
  audio_codec = COALESCE(excluded.audio_codec, media.audio_codec),
  pixel_format = COALESCE(excluded.pixel_format, media.pixel_format),
  root_id = excluded.root_id,
  relative_path = excluded.relative_path,
  library_kind = excluded.library_kind,
  collection_title = excluded.collection_title,
  policy_enabled = excluded.policy_enabled,
  collection_id = excluded.collection_id,
  season_number = excluded.season_number,
  episode_number = excluded.episode_number,
  episode_title = excluded.episode_title
`

const MEDIA_UPSERT_SQL = `
  INSERT INTO media (
    path, filename, duration_seconds, is_interlude, media_type,
    date_start, date_end, codec, width, height, warning, mtime, compatibility,
    has_audio, audio_codec, pixel_format,
    root_id, relative_path, library_kind, collection_title,
    policy_enabled, playback_override, root_available,
    collection_id, season_number, episode_number, episode_title
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(path) DO UPDATE SET
    ${MEDIA_UPSERT_UPDATE}
  ON CONFLICT(root_id, relative_path) DO UPDATE SET
    path = excluded.path,
    ${MEDIA_UPSERT_UPDATE}
`

const COLLECTION_AGGREGATE_SELECT = `
  SELECT
    collection.*,
    COUNT(media.id) AS file_count,
    COUNT(DISTINCT CASE
      WHEN media.season_number IS NOT NULL THEN media.season_number
    END) AS season_count,
    COALESCE(SUM(CASE
      WHEN collection.library_kind = 'tv' AND media.media_type = 'video' THEN 1
      ELSE 0
    END), 0) AS episode_count,
    COALESCE(SUM(CASE
      WHEN media.duration_seconds > 0 AND media.warning IS NULL THEN 1
      ELSE 0
    END), 0) AS ready_file_count,
    COALESCE(SUM(CASE
      WHEN media.id IS NOT NULL
        AND (media.duration_seconds <= 0 OR media.warning IS NOT NULL) THEN 1
      ELSE 0
    END), 0) AS failed_file_count,
    COALESCE(SUM(CASE
      WHEN media.playback_override IS NOT NULL THEN 1
      ELSE 0
    END), 0) AS legacy_override_count,
    COALESCE(SUM(CASE
      WHEN media.media_type = 'video'
        AND media.is_interlude = 0
        AND media.root_available = 1
        AND media.duration_seconds > 0
        AND COALESCE(media.playback_override, media.policy_enabled) = 1
      THEN 1 ELSE 0
    END), 0) AS schedule_eligible_count,
    COALESCE(MAX(media.root_available), 0) AS root_available
  FROM media_collections AS collection
  LEFT JOIN media ON media.collection_id = collection.id
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
    this.db.exec(COLLECTION_SCHEMA)

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

    // Audio stream presence, probed once during indexing so the channel
    // worker never needs a runtime ffprobe before spawning an encoder.
    const hasHasAudio = columns.some((c) => c.name === 'has_audio')
    if (!hasHasAudio) {
      this.db.exec(`ALTER TABLE media ADD COLUMN has_audio INTEGER`)
      this.db.exec(`ALTER TABLE media ADD COLUMN audio_codec TEXT`)
      console.log('Migrated database to include audio probe columns')
    }

    // Pixel format (bit-depth source) for hardware-decode eligibility.
    const hasPixelFormat = columns.some((c) => c.name === 'pixel_format')
    if (!hasPixelFormat) {
      this.db.exec(`ALTER TABLE media ADD COLUMN pixel_format TEXT`)
      console.log('Migrated database to include pixel_format column')
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
        `ALTER TABLE media ADD COLUMN policy_enabled INTEGER NOT NULL DEFAULT 0`
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

    // Collection catalog migration. This deliberately initializes automatic
    // policy to review and preserves existing per-file playback_override rows
    // without broadening them to an entire collection.
    const collectionMigration = this.db
      .prepare('SELECT version FROM schema_migrations WHERE version = 1')
      .get() as { version: number } | null
    if (!collectionMigration) {
      const currentColumns = this.db
        .prepare('PRAGMA table_info(media)')
        .all() as Array<{ name: string }>
      const hasColumn = (name: string) =>
        currentColumns.some((column) => column.name === name)
      const transaction = this.db.transaction(() => {
        if (!hasColumn('collection_id')) {
          this.db!.exec(`ALTER TABLE media ADD COLUMN collection_id INTEGER`)
        }
        if (!hasColumn('season_number')) {
          this.db!.exec(`ALTER TABLE media ADD COLUMN season_number INTEGER`)
        }
        if (!hasColumn('episode_number')) {
          this.db!.exec(`ALTER TABLE media ADD COLUMN episode_number INTEGER`)
        }
        if (!hasColumn('episode_title')) {
          this.db!.exec(`ALTER TABLE media ADD COLUMN episode_title TEXT`)
        }

        this.db!.exec(`
          INSERT OR IGNORE INTO media_collections (
            root_id, library_kind, identity_key, source_title, parsed_title,
            year, policy_decision, policy_reason
          )
          SELECT
            root_id,
            library_kind,
            lower(trim(collection_title)),
            collection_title,
            trim(collection_title),
            NULL,
            'review',
            'migration_requires_review'
          FROM media
          WHERE collection_title IS NOT NULL AND trim(collection_title) <> ''
          GROUP BY root_id, library_kind, lower(trim(collection_title))
        `)
        this.db!.exec(`
          UPDATE media
          SET collection_id = (
            SELECT collection.id
            FROM media_collections AS collection
            WHERE collection.root_id = media.root_id
              AND collection.library_kind = media.library_kind
              AND collection.identity_key = lower(trim(media.collection_title))
          )
          WHERE collection_id IS NULL
        `)
        this.db!.prepare(
          `INSERT INTO schema_migrations (version) VALUES (1)`
        ).run()
      })
      transaction()
    }

    // Episode metadata is provider-owned and deliberately separate from the
    // filename-derived episode title that is refreshed by every media scan.
    const episodeColumns = this.db
      .prepare('PRAGMA table_info(media)')
      .all() as Array<{ name: string }>
    const hasEpisodeColumn = (name: string) =>
      episodeColumns.some((column) => column.name === name)
    for (const [name, type] of [
      ['episode_metadata_title', 'TEXT'],
      ['episode_overview', 'TEXT'],
      ['episode_air_date', 'TEXT'],
      ['episode_still_path', 'TEXT'],
    ] as const) {
      if (!hasEpisodeColumn(name)) {
        this.db.exec(`ALTER TABLE media ADD COLUMN ${name} ${type}`)
      }
    }

    this.migrateStationFacets()
    this.migrateEpisodeMetadata()

    this.sanitizeAndGuardCollectionOverrides()

    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_media_collection ON media(collection_id);`
    )
    this.syncAllCollectionEligibility()

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

  /** Versioned one-time queue for network/production-company station facets. */
  private migrateStationFacets(): void {
    if (!this.db) throw new Error('Repository not initialized')
    const stationFacetMigration = this.db
      .prepare('SELECT version FROM schema_migrations WHERE version = 2')
      .get() as { version: number } | null
    if (!stationFacetMigration) {
      const collectionColumns = this.db
        .prepare('PRAGMA table_info(media_collections)')
        .all() as Array<{ name: string }>
      const hasCollectionColumn = (name: string) =>
        collectionColumns.some((column) => column.name === name)
      const transaction = this.db.transaction(() => {
        if (!hasCollectionColumn('networks_json')) {
          this.db!.exec(
            `ALTER TABLE media_collections ADD COLUMN networks_json TEXT NOT NULL DEFAULT '[]'`
          )
        }
        if (!hasCollectionColumn('studios_json')) {
          this.db!.exec(
            `ALTER TABLE media_collections ADD COLUMN studios_json TEXT NOT NULL DEFAULT '[]'`
          )
        }
        // Existing matched rows predate these facets. Queue a direct hydrate
        // by stable external ID; metadata locks and parent overrides remain
        // untouched, and the sequential worker runs after the startup scan.
        this.db!.exec(`
          UPDATE media_collections
          SET metadata_status = 'pending',
              metadata_error = NULL,
              updated_at = CURRENT_TIMESTAMP
          WHERE metadata_provider = 'tmdb'
            AND metadata_external_id IS NOT NULL
            AND trim(metadata_external_id) <> ''
            AND metadata_status IN ('matched', 'manual')
        `)
        this.db!.prepare(
          `INSERT INTO schema_migrations (version) VALUES (2)`
        ).run()
      })
      transaction()
    }
  }

  /** Queue one direct TMDB refresh for shows matched before episode storage. */
  private migrateEpisodeMetadata(): void {
    if (!this.db) throw new Error('Repository not initialized')
    const migration = this.db
      .prepare('SELECT version FROM schema_migrations WHERE version = 3')
      .get() as { version: number } | null
    if (migration) return
    this.db.transaction(() => {
      this.db!.exec(`
        UPDATE media_collections
        SET metadata_status = 'pending',
            metadata_error = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE library_kind = 'tv'
          AND metadata_provider = 'tmdb'
          AND metadata_external_id IS NOT NULL
          AND trim(metadata_external_id) <> ''
          AND metadata_status IN ('matched', 'manual')
          AND EXISTS (
            SELECT 1 FROM media
            WHERE media.collection_id = media_collections.id
              AND media.season_number IS NOT NULL
              AND media.episode_number IS NOT NULL
          )
      `)
      this.db!.prepare(
        `INSERT INTO schema_migrations (version) VALUES (3)`
      ).run()
    })()
  }

  private sanitizeAndGuardCollectionOverrides(): void {
    if (!this.db) throw new Error('Repository not initialized')
    // Old/corrupt override values must never fall through to a stored allow.
    // Convert them into an explicit review decision before installing guards.
    this.db.exec(`
      UPDATE media_collections
      SET parent_override = NULL,
          override_at = NULL,
          policy_decision = 'review',
          policy_reason = 'invalid_parent_override',
          updated_at = CURRENT_TIMESTAMP
      WHERE parent_override IS NOT NULL
        AND parent_override NOT IN ('allow', 'block');

      CREATE TRIGGER IF NOT EXISTS validate_collection_parent_override_insert
      BEFORE INSERT ON media_collections
      WHEN NEW.parent_override IS NOT NULL
        AND NEW.parent_override NOT IN ('allow', 'block')
      BEGIN
        SELECT RAISE(ABORT, 'invalid collection parent override');
      END;

      CREATE TRIGGER IF NOT EXISTS validate_collection_parent_override_update
      BEFORE UPDATE OF parent_override ON media_collections
      WHEN NEW.parent_override IS NOT NULL
        AND NEW.parent_override NOT IN ('allow', 'block')
      BEGIN
        SELECT RAISE(ABORT, 'invalid collection parent override');
      END;
    `)
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

  async upsertCollections(
    collections: readonly CollectionUpsertInput[]
  ): Promise<MediaCollection[]> {
    if (!this.db) throw new Error('Repository not initialized')
    if (collections.length === 0) return []

    const upsert = this.db.prepare(`
      INSERT INTO media_collections (
        root_id, library_kind, identity_key, source_title, parsed_title, year,
        present, last_seen_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(root_id, library_kind, identity_key) DO UPDATE SET
        source_title = excluded.source_title,
        parsed_title = excluded.parsed_title,
        year = excluded.year,
        present = 1,
        last_seen_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    `)
    const selectId = this.db.prepare(`
      SELECT id FROM media_collections
      WHERE root_id = ? AND library_kind = ? AND identity_key = ?
    `)
    const ids: number[] = []
    const transaction = this.db.transaction(() => {
      for (const collection of collections) {
        upsert.run(
          collection.rootId,
          collection.libraryKind,
          collection.identityKey,
          collection.sourceTitle,
          collection.parsedTitle,
          collection.year
        )
        const row = selectId.get(
          collection.rootId,
          collection.libraryKind,
          collection.identityKey
        ) as { id: number } | null
        if (!row) throw new Error('Collection upsert did not return an identity')
        ids.push(row.id)
      }
    })
    transaction()

    const uniqueIds = [...new Set(ids)]
    const placeholders = uniqueIds.map(() => '?').join(',')
    const rows = this.db
      .prepare(`
        ${COLLECTION_AGGREGATE_SELECT}
        WHERE collection.id IN (${placeholders})
        GROUP BY collection.id
      `)
      .all(...uniqueIds) as Array<Record<string, unknown>>
    const byId = new Map(
      rows.map((row) => {
        const collection = this.rowToMediaCollection(row)
        return [collection.id, collection] as const
      })
    )
    return ids.map((id) => {
      const collection = byId.get(id)
      if (!collection) throw new Error(`Collection ${id} disappeared after upsert`)
      return collection
    })
  }

  async reconcileCollections(
    rootId: string,
    presentIdentityKeys: readonly string[]
  ): Promise<number> {
    if (!this.db) throw new Error('Repository not initialized')

    const uniqueKeys = [...new Set(presentIdentityKeys)]
    let retired = 0
    const transaction = this.db.transaction(() => {
      retired = this.db!
        .prepare(
          `UPDATE media_collections
           SET present = 0, updated_at = CURRENT_TIMESTAMP
           WHERE root_id = ? AND present = 1`
        )
        .run(rootId).changes

      const restore = this.db!.prepare(`
        UPDATE media_collections
        SET present = 1, last_seen_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE root_id = ? AND identity_key = ?
      `)
      for (const identityKey of uniqueKeys) restore.run(rootId, identityKey)
    })
    transaction()
    return retired
  }

  async getCollections(
    options: CollectionListOptions = {}
  ): Promise<MediaCollection[]> {
    if (!this.db) throw new Error('Repository not initialized')

    const clauses: string[] = []
    const values: Array<string | number> = []
    if (options.presentOnly !== false) clauses.push('collection.present = 1')
    if (options.kind) {
      clauses.push('collection.library_kind = ?')
      values.push(options.kind)
    }
    if (options.effectiveDecision) {
      clauses.push(`${COLLECTION_EFFECTIVE_DECISION_SQL} = ?`)
      values.push(options.effectiveDecision)
    }
    if (options.metadataStatus) {
      clauses.push('collection.metadata_status = ?')
      values.push(options.metadataStatus)
    }
    if (options.metadataReview) {
      clauses.push(`(
        collection.metadata_status IN (
          'ambiguous', 'unmatched', 'error', 'not_configured'
        ) OR (
          collection.metadata_status IN ('matched', 'manual')
          AND collection.rating_status <> 'resolved'
        )
      )`)
    }
    const search = options.search?.trim()
    if (search) {
      clauses.push(`(
        collection.source_title LIKE ? COLLATE NOCASE OR
        collection.parsed_title LIKE ? COLLATE NOCASE OR
        collection.metadata_title LIKE ? COLLATE NOCASE OR
        EXISTS (
          SELECT 1 FROM media AS searchable_media
          WHERE searchable_media.collection_id = collection.id
            AND (
              searchable_media.filename LIKE ? COLLATE NOCASE OR
              searchable_media.episode_title LIKE ? COLLATE NOCASE
            )
        )
      )`)
      const pattern = `%${search}%`
      values.push(pattern, pattern, pattern, pattern, pattern)
    }

    const limit = Math.max(1, Math.min(250, Math.trunc(options.limit ?? 100)))
    const offset = Math.max(0, Math.trunc(options.offset ?? 0))
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const having = options.scheduleEligibleOnly
      ? 'HAVING schedule_eligible_count > 0'
      : ''
    const rows = this.db
      .prepare(`
        ${COLLECTION_AGGREGATE_SELECT}
        ${where}
        GROUP BY collection.id
        ${having}
        ORDER BY COALESCE(collection.metadata_title, collection.parsed_title)
          COLLATE NOCASE, collection.id
        LIMIT ? OFFSET ?
      `)
      .all(...values, limit, offset) as Array<Record<string, unknown>>
    return rows.map((row) => this.rowToMediaCollection(row))
  }

  async getCollectionById(id: number): Promise<MediaCollection | null> {
    if (!this.db) throw new Error('Repository not initialized')
    const row = this.db
      .prepare(`
        ${COLLECTION_AGGREGATE_SELECT}
        WHERE collection.id = ?
        GROUP BY collection.id
      `)
      .get(id) as Record<string, unknown> | null
    return row ? this.rowToMediaCollection(row) : null
  }

  async getCollectionMedia(id: number): Promise<MediaItem[]> {
    if (!this.db) throw new Error('Repository not initialized')
    const rows = this.db
      .prepare(`
        SELECT ${MEDIA_COLUMNS}
        FROM media
        WHERE collection_id = ?
        ORDER BY COALESCE(season_number, -1), COALESCE(episode_number, -1),
          filename COLLATE NOCASE
      `)
      .all(id) as Array<Record<string, unknown>>
    return rows.map((row) => this.rowToMediaItem(row))
  }

  async getMediaPage(options: MediaFileListOptions): Promise<MediaFilePage> {
    if (!this.db) throw new Error('Repository not initialized')

    // Keep the database boundary bounded even if a non-HTTP caller supplies
    // unexpected values. The Advanced Files controller currently requests 100.
    const limit = Number.isSafeInteger(options.limit)
      ? Math.max(1, Math.min(250, options.limit))
      : 100
    const offset = Number.isSafeInteger(options.offset)
      ? Math.max(0, options.offset)
      : 0
    const conditions: string[] = []
    const bindings: Array<string | number> = []
    const playableSql = `
      root_available = 1
      AND duration_seconds > 0
      AND COALESCE(playback_override, policy_enabled, 0) = 1
    `

    switch (options.filter) {
      case 'approved':
        conditions.push(`(${playableSql})`)
        break
      case 'blocked':
        conditions.push(`NOT (${playableSql})`)
        break
      case 'errors':
        conditions.push('(duration_seconds <= 0 OR warning IS NOT NULL)')
        break
      case 'videos':
        conditions.push('is_interlude = 0')
        break
      case 'interludes':
        conditions.push('is_interlude = 1')
        break
      case 'all':
        break
    }

    if (options.search) {
      // instr() treats %, _ and backslashes literally, matching the former
      // in-memory substring search without exposing LIKE wildcard behavior.
      conditions.push(`(
        instr(lower(filename), lower(?)) > 0
        OR instr(lower(COALESCE(collection_title, '')), lower(?)) > 0
      )`)
      bindings.push(options.search, options.search)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const prioritizedIds = [...new Set(options.prioritizedIds ?? [])].filter(
      (id) => Number.isSafeInteger(id) && id > 0
    )
    const priorityOrder =
      prioritizedIds.length > 0
        ? `CASE id ${prioritizedIds
            .map((_, index) => `WHEN ? THEN ${index}`)
            .join(' ')} ELSE ${prioritizedIds.length} END,`
        : ''

    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS count FROM media ${where}`)
      .get(...bindings) as { count: number }
    const rows = this.db
      .prepare(`
        SELECT ${MEDIA_COLUMNS}
        FROM media
        ${where}
        ORDER BY ${priorityOrder} filename COLLATE NOCASE, id
        LIMIT ? OFFSET ?
      `)
      .all(...bindings, ...prioritizedIds, limit, offset) as Array<
      Record<string, unknown>
    >

    return {
      items: rows.map((row) => this.rowToMediaItem(row)),
      total: Number(totalRow.count),
    }
  }

  async getLibrarySummary(): Promise<LibrarySummary> {
    if (!this.db) throw new Error('Repository not initialized')
    const collections = this.db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN library_kind = 'tv' THEN 1 ELSE 0 END), 0)
          AS tv_collections,
        COALESCE(SUM(CASE WHEN library_kind = 'movie' THEN 1 ELSE 0 END), 0)
          AS movie_collections,
        COALESCE(SUM(CASE WHEN effective_decision = 'allow' THEN 1 ELSE 0 END), 0)
          AS approved_collections,
        COALESCE(SUM(CASE WHEN effective_decision = 'review' THEN 1 ELSE 0 END), 0)
          AS review_collections,
        COALESCE(SUM(CASE WHEN effective_decision = 'block' THEN 1 ELSE 0 END), 0)
          AS blocked_collections,
        COALESCE(SUM(CASE
          WHEN metadata_status IN ('ambiguous', 'unmatched', 'error') THEN 1
          ELSE 0 END), 0) AS unmatched_collections,
        COALESCE(SUM(CASE
          WHEN metadata_status IN ('pending', 'not_configured') THEN 1
          ELSE 0 END), 0) AS metadata_pending_collections,
        COALESCE(SUM(CASE
          WHEN metadata_status IN ('matched', 'manual') THEN 1
          ELSE 0 END), 0) AS metadata_matched_collections,
        COALESCE(SUM(CASE
          WHEN metadata_status IN ('ambiguous', 'unmatched', 'error', 'not_configured')
            OR (metadata_status IN ('matched', 'manual') AND rating_status <> 'resolved')
          THEN 1 ELSE 0 END), 0) AS metadata_review_collections
      FROM (
        SELECT library_kind, metadata_status, rating_status,
          ${COLLECTION_EFFECTIVE_DECISION_SQL} AS effective_decision
        FROM media_collections AS collection
        WHERE present = 1
      )
    `).get() as Record<string, number>
    const media = this.db.prepare(`
      SELECT
        COUNT(*) AS total_files,
        COALESCE(SUM(CASE
          WHEN library_kind = 'tv' AND media_type = 'video' THEN 1 ELSE 0 END
        ), 0) AS tv_episodes,
        COALESCE(SUM(CASE WHEN media_type = 'interlude' THEN 1 ELSE 0 END), 0)
          AS interlude_files,
        COALESCE(SUM(CASE
          WHEN duration_seconds <= 0 OR warning IS NOT NULL THEN 1 ELSE 0 END
        ), 0) AS probe_failed_files
      FROM media
    `).get() as Record<string, number>

    return {
      tvCollections: Number(collections.tv_collections ?? 0),
      tvEpisodes: Number(media.tv_episodes ?? 0),
      movieCollections: Number(collections.movie_collections ?? 0),
      interludeFiles: Number(media.interlude_files ?? 0),
      totalFiles: Number(media.total_files ?? 0),
      approvedCollections: Number(collections.approved_collections ?? 0),
      reviewCollections: Number(collections.review_collections ?? 0),
      blockedCollections: Number(collections.blocked_collections ?? 0),
      unmatchedCollections: Number(collections.unmatched_collections ?? 0),
      metadataPendingCollections: Number(
        collections.metadata_pending_collections ?? 0
      ),
      metadataMatchedCollections: Number(
        collections.metadata_matched_collections ?? 0
      ),
      metadataReviewCollections: Number(
        collections.metadata_review_collections ?? 0
      ),
      probeFailedFiles: Number(media.probe_failed_files ?? 0),
    }
  }

  async updateCollectionPolicy(
    id: number,
    decision: PolicyDecision,
    reason: string,
    profileId = 'kids-7'
  ): Promise<boolean> {
    if (!this.db) throw new Error('Repository not initialized')
    if (!this.isPolicyDecision(decision)) return false
    return this.db.transaction(() => {
      const result = this.db!
        .prepare(`
          UPDATE media_collections
          SET policy_decision = ?, policy_reason = ?, policy_profile_id = ?,
              policy_version = policy_version + 1,
              policy_evaluated_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `)
        .run(decision, reason, profileId, id)
      if (result.changes > 0) this.syncCollectionEligibility(id)
      return result.changes > 0
    })()
  }

  async updateCollectionOverride(
    id: number,
    decision: OverrideDecision
  ): Promise<boolean> {
    if (!this.db) throw new Error('Repository not initialized')
    if (decision !== null && decision !== 'allow' && decision !== 'block') {
      return false
    }
    return this.db.transaction(() => {
      const result = this.db!
        .prepare(`
          UPDATE media_collections
          SET parent_override = ?,
              override_at = CASE WHEN ? IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `)
        .run(decision, decision, id)
      if (result.changes > 0) this.syncCollectionEligibility(id)
      return result.changes > 0
    })()
  }

  async updateCollectionMetadata(
    id: number,
    metadata: CollectionMetadataUpdate
  ): Promise<boolean> {
    if (!this.db) throw new Error('Repository not initialized')

    const assignments = [
      'metadata_provider = ?',
      'metadata_external_id = ?',
      'metadata_status = ?',
      'metadata_refreshed_at = CURRENT_TIMESTAMP',
      'updated_at = CURRENT_TIMESTAMP',
    ]
    const values: Array<string | number | null> = [
      metadata.provider,
      metadata.externalId,
      metadata.status,
    ]
    const scalar = (value: unknown): string | number | null =>
      typeof value === 'string' || typeof value === 'number' ? value : null
    const optional: Array<
      [
        keyof CollectionMetadataUpdate,
        string,
        (value: unknown) => string | number | null,
      ]
    > = [
      ['locked', 'metadata_locked', (value) => (value ? 1 : 0)],
      ['title', 'metadata_title', scalar],
      ['originalTitle', 'metadata_original_title', scalar],
      ['year', 'metadata_year', scalar],
      ['overview', 'overview', scalar],
      ['posterPath', 'poster_path', scalar],
      ['backdropPath', 'backdrop_path', scalar],
      ['genres', 'genres_json', (value) => JSON.stringify(value ?? [])],
      ['networks', 'networks_json', (value) => JSON.stringify(value ?? [])],
      ['studios', 'studios_json', (value) => JSON.stringify(value ?? [])],
      ['certification', 'certification', scalar],
      ['certificationRegion', 'certification_region', scalar],
      ['ratingStatus', 'rating_status', scalar],
      ['matchConfidence', 'match_confidence', scalar],
      [
        'candidates',
        'metadata_candidates_json',
        (value) => JSON.stringify(value ?? []),
      ],
      ['error', 'metadata_error', scalar],
      ['matchedAt', 'metadata_matched_at', scalar],
    ]
    for (const [key, column, serialize] of optional) {
      if (Object.prototype.hasOwnProperty.call(metadata, key)) {
        assignments.push(`${column} = ?`)
        values.push(serialize(metadata[key]))
      }
    }
    values.push(id)
    const result = this.db
      .prepare(
        `UPDATE media_collections SET ${assignments.join(', ')} WHERE id = ?`
      )
      .run(...values)
    return result.changes > 0
  }

  async updateCollectionEpisodeMetadata(
    collectionId: number,
    episodes: readonly EpisodeMetadataUpdate[]
  ): Promise<number> {
    if (!this.db) throw new Error('Repository not initialized')
    if (!Number.isSafeInteger(collectionId) || collectionId <= 0) {
      throw new Error('Invalid collection ID')
    }
    if (episodes.length > 10_000) throw new Error('Too many episode records')

    const update = this.db.prepare(`
      UPDATE media
      SET episode_metadata_title = ?, episode_overview = ?,
          episode_air_date = ?, episode_still_path = ?
      WHERE collection_id = ? AND season_number = ? AND episode_number = ?
    `)
    return this.db.transaction(() => {
      this.db!.prepare(`
        UPDATE media
        SET episode_metadata_title = NULL, episode_overview = NULL,
            episode_air_date = NULL, episode_still_path = NULL
        WHERE collection_id = ?
      `).run(collectionId)
      let changed = 0
      for (const episode of episodes) {
        if (
          !Number.isSafeInteger(episode.seasonNumber) ||
          episode.seasonNumber < 0 ||
          !Number.isSafeInteger(episode.episodeNumber) ||
          episode.episodeNumber <= 0 ||
          !episode.title.trim()
        ) {
          continue
        }
        changed += update.run(
          episode.title.trim(),
          episode.overview?.trim() || null,
          episode.airDate?.trim() || null,
          episode.stillPath?.trim() || null,
          collectionId,
          episode.seasonNumber,
          episode.episodeNumber
        ).changes
      }

      // Sonarr/Plex may place two numbered broadcast segments in one physical
      // file (for example S01E01-E02). The ordinary update above associates
      // the file with E01; replace that single title with the provider titles
      // for the complete range so clients do not have to show a release name.
      const metadataByEpisode = new Map(
        episodes.map((episode) => [
          `${episode.seasonNumber}:${episode.episodeNumber}`,
          episode,
        ])
      )
      const multiEpisodeFiles = this.db!
        .prepare(`
          SELECT id, relative_path, filename
          FROM media
          WHERE collection_id = ?
        `)
        .all(collectionId) as Array<{
        id: number
        relative_path: string
        filename: string
      }>
      const updateMultiEpisode = this.db!.prepare(`
        UPDATE media
        SET episode_metadata_title = ?, episode_overview = ?,
            episode_air_date = ?, episode_still_path = ?
        WHERE id = ?
      `)
      for (const file of multiEpisodeFiles) {
        const range = parseEpisodeRange(file.relative_path || file.filename)
        if (!range?.endEpisodeNumber) continue
        const parts: EpisodeMetadataUpdate[] = []
        for (
          let number = range.episodeNumber;
          number <= range.endEpisodeNumber;
          number += 1
        ) {
          const episode = metadataByEpisode.get(`${range.seasonNumber}:${number}`)
          if (episode) parts.push(episode)
        }
        if (parts.length < 2) continue
        const first = parts[0]!
        updateMultiEpisode.run(
          parts.map((episode) => episode.title.trim()).join(' + '),
          parts
            .map((episode) => episode.overview?.trim())
            .filter((overview): overview is string => Boolean(overview))
            .join('\n\n') || null,
          first.airDate?.trim() || null,
          first.stillPath?.trim() || null,
          file.id
        )
      }
      return changed
    })()
  }

  async getCollectionsNeedingMetadata(limit = 25): Promise<MediaCollection[]> {
    if (!this.db) throw new Error('Repository not initialized')
    const boundedLimit = Math.max(1, Math.min(5000, Math.trunc(limit)))
    const rows = this.db
      .prepare(`
        ${COLLECTION_AGGREGATE_SELECT}
        WHERE collection.present = 1
          AND collection.metadata_status IN ('pending', 'error', 'not_configured')
          AND (
            collection.metadata_locked = 0
            OR collection.metadata_external_id IS NOT NULL
          )
        GROUP BY collection.id
        ORDER BY
          CASE collection.metadata_status WHEN 'pending' THEN 0 ELSE 1 END,
          collection.updated_at, collection.id
        LIMIT ?
      `)
      .all(boundedLimit) as Array<Record<string, unknown>>
    return rows.map((row) => this.rowToMediaCollection(row))
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
        item.hasAudio === null || item.hasAudio === undefined
          ? null
          : item.hasAudio
            ? 1
            : 0,
        item.audioCodec ?? null,
        item.pixelFormat ?? null,
        item.rootId ?? 'legacy',
        item.relativePath ?? item.path,
        item.libraryKind ?? 'other',
        item.collectionTitle ?? item.filename,
        item.policyEnabled === true ? 1 : 0,
        item.playbackOverride === null || item.playbackOverride === undefined
          ? null
          : item.playbackOverride
            ? 1
            : 0,
        (item.rootAvailable ?? true) ? 1 : 0,
        item.collectionId ?? null,
        item.seasonNumber ?? null,
        item.episodeNumber ?? null,
        item.episodeTitle ?? null
      )
      // The indexer necessarily takes a snapshot of the collection before it
      // probes a file. A parent can change the collection decision while that
      // probe is running, so the snapshot's policyEnabled value may already be
      // stale by the time this upsert lands. Re-derive linked rows from the
      // authoritative collection in the same transaction.
      if (item.collectionId != null) {
        this.syncCollectionEligibility(item.collectionId)
      }
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
    const transaction = this.db.transaction(() => {
      this.db!
        .prepare('UPDATE media SET playback_override = ? WHERE id = ?')
        .run(enabled === null ? null : enabled ? 1 : 0, id)

      if (enabled !== null) return
      // "Use collection decision" must also repair rows written by an older
      // scanner snapshot. Clearing the file override alone can otherwise
      // expose a stale policy_enabled value until the next full scan/restart.
      const row = this.db!
        .prepare('SELECT collection_id FROM media WHERE id = ?')
        .get(id) as { collection_id: number | null } | null
      if (row?.collection_id != null) {
        this.syncCollectionEligibility(row.collection_id)
      }
    })
    transaction()
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
      }
      // The old JSON allowlist is now only a programming-group fallback. It
      // must not restore historical automatic approval. Collection policy is
      // authoritative, while collectionless rows remain review-only.
      changed += this.db!
        .prepare('UPDATE media SET policy_enabled = 0 WHERE collection_id IS NULL')
        .run().changes
      this.syncAllCollectionEligibility()
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

  private syncAllCollectionEligibility(): void {
    if (!this.db) throw new Error('Repository not initialized')
    this.db.exec(`
      UPDATE media
      SET policy_enabled = CASE
        WHEN EXISTS (
          SELECT 1
          FROM media_collections AS collection
          WHERE collection.id = media.collection_id
            AND ${COLLECTION_EFFECTIVE_DECISION_SQL} = 'allow'
        ) THEN 1
        ELSE 0
      END
    `)
  }

  private syncCollectionEligibility(collectionId: number): void {
    if (!this.db) throw new Error('Repository not initialized')
    this.db.prepare(`
      UPDATE media
      SET policy_enabled = CASE
        WHEN EXISTS (
          SELECT 1
          FROM media_collections AS collection
          WHERE collection.id = media.collection_id
            AND ${COLLECTION_EFFECTIVE_DECISION_SQL} = 'allow'
        ) THEN 1
        ELSE 0
      END
      WHERE collection_id = ?
    `).run(collectionId)
  }

  private rowToMediaCollection(row: Record<string, unknown>): MediaCollection {
    const rawPolicy = row.policy_decision
    const policyDecision: PolicyDecision = this.isPolicyDecision(rawPolicy)
      ? rawPolicy
      : 'review'
    const rawOverride = row.parent_override
    const parentOverride: OverrideDecision =
      rawOverride === 'allow' || rawOverride === 'block' ? rawOverride : null
    const resolved = resolveEffectiveDecision(
      policyDecision,
      rawOverride === null || rawOverride === undefined
        ? null
        : (rawOverride as OverrideDecision)
    )
    return {
      id: Number(row.id),
      rootId: String(row.root_id ?? 'legacy'),
      libraryKind: this.normalizeLibraryKind(row.library_kind),
      identityKey: String(row.identity_key ?? ''),
      sourceTitle: String(row.source_title ?? ''),
      parsedTitle: String(row.parsed_title ?? ''),
      year: this.nullableNumber(row.year),
      present: Boolean(row.present),
      metadataProvider: this.nullableString(row.metadata_provider),
      metadataExternalId: this.nullableString(row.metadata_external_id),
      metadataStatus: this.normalizeMetadataStatus(row.metadata_status),
      metadataLocked: Boolean(row.metadata_locked),
      metadataTitle: this.nullableString(row.metadata_title),
      metadataOriginalTitle: this.nullableString(row.metadata_original_title),
      metadataYear: this.nullableNumber(row.metadata_year),
      overview: this.nullableString(row.overview),
      posterPath: this.nullableString(row.poster_path),
      backdropPath: this.nullableString(row.backdrop_path),
      genres: this.parseStringArray(row.genres_json),
      networks: this.parseStringArray(row.networks_json),
      studios: this.parseStringArray(row.studios_json),
      certification: this.nullableString(row.certification),
      certificationRegion: this.nullableString(row.certification_region),
      ratingStatus: this.normalizeRatingStatus(row.rating_status),
      matchConfidence: this.nullableNumber(row.match_confidence),
      metadataCandidates: this.parseCandidates(row.metadata_candidates_json),
      metadataError: this.nullableString(row.metadata_error),
      policyDecision,
      policyReason: String(row.policy_reason ?? 'metadata_pending'),
      policyProfileId: String(row.policy_profile_id ?? 'kids-7'),
      parentOverride,
      effectiveDecision: resolved.decision,
      decisionSource:
        resolved.source === 'parent_override'
          ? 'parent'
          : resolved.source === 'policy'
            ? 'policy'
            : 'fail_closed',
      fileCount: Number(row.file_count ?? 0),
      seasonCount: Number(row.season_count ?? 0),
      episodeCount: Number(row.episode_count ?? 0),
      readyFileCount: Number(row.ready_file_count ?? 0),
      failedFileCount: Number(row.failed_file_count ?? 0),
      legacyOverrideCount: Number(row.legacy_override_count ?? 0),
      scheduleEligibleCount: Number(row.schedule_eligible_count ?? 0),
      rootAvailable: Boolean(row.root_available),
      createdAt: String(row.created_at ?? ''),
      updatedAt: String(row.updated_at ?? ''),
    }
  }

  private isPolicyDecision(value: unknown): value is PolicyDecision {
    return value === 'allow' || value === 'review' || value === 'block'
  }

  private normalizeMetadataStatus(value: unknown): MetadataMatchStatus {
    switch (value) {
      case 'matched':
      case 'ambiguous':
      case 'unmatched':
      case 'manual':
      case 'error':
      case 'not_configured':
        return value
      default:
        return 'pending'
    }
  }

  private normalizeRatingStatus(value: unknown): MetadataRatingStatus {
    return value === 'resolved' || value === 'ambiguous' ? value : 'missing'
  }

  private nullableString(value: unknown): string | null {
    return typeof value === 'string' ? value : null
  }

  private nullableNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  }

  private parseStringArray(value: unknown): readonly string[] {
    if (typeof value !== 'string') return []
    try {
      const parsed: unknown = JSON.parse(value)
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === 'string')
        : []
    } catch {
      return []
    }
  }

  private parseCandidates(value: unknown): readonly MetadataCandidateRecord[] {
    if (typeof value !== 'string') return []
    try {
      const parsed: unknown = JSON.parse(value)
      if (!Array.isArray(parsed)) return []
      return parsed.filter((candidate): candidate is MetadataCandidateRecord => {
        if (!candidate || typeof candidate !== 'object') return false
        const record = candidate as Record<string, unknown>
        return (
          typeof record.provider === 'string' &&
          typeof record.externalId === 'string' &&
          (record.mediaType === 'movie' || record.mediaType === 'tv') &&
          typeof record.title === 'string' &&
          typeof record.confidence === 'number'
        )
      })
    } catch {
      return []
    }
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
      hasAudio:
        row.has_audio === null || row.has_audio === undefined
          ? null
          : Boolean(row.has_audio),
      audioCodec: (row.audio_codec as string) ?? null,
      pixelFormat: (row.pixel_format as string) ?? null,
      rootId: (row.root_id as string) ?? 'legacy',
      relativePath: (row.relative_path as string) ?? (row.path as string),
      libraryKind: this.normalizeLibraryKind(row.library_kind),
      collectionTitle:
        (row.collection_title as string) ?? (row.filename as string),
      collectionMetadataTitle:
        (row.collection_metadata_title as string | null) ?? null,
      collectionGenres: this.parseStringArray(row.collection_genres_json),
      policyEnabled: Boolean(row.policy_enabled),
      playbackOverride:
        row.playback_override === null || row.playback_override === undefined
          ? null
          : Boolean(row.playback_override),
      rootAvailable: Boolean(row.root_available ?? 1),
      playbackEnabled: Boolean(
        (row.root_available ?? 1) &&
          Number(row.duration_seconds) > 0 &&
          (row.playback_override ?? row.policy_enabled ?? 0)
      ),
      collectionId: (row.collection_id as number | null) ?? null,
      collectionIdentityKey:
        (row.collection_identity_key as string | null) ?? null,
      seasonNumber: (row.season_number as number | null) ?? null,
      episodeNumber: (row.episode_number as number | null) ?? null,
      episodeTitle: (row.episode_title as string | null) ?? null,
      episodeMetadataTitle:
        (row.episode_metadata_title as string | null) ?? null,
      episodeOverview: (row.episode_overview as string | null) ?? null,
      episodeAirDate: (row.episode_air_date as string | null) ?? null,
      episodeStillPath: (row.episode_still_path as string | null) ?? null,
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
      const linkedCollectionIds = new Set<number>()
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
          item.hasAudio === null || item.hasAudio === undefined
            ? null
            : item.hasAudio
              ? 1
              : 0,
          item.audioCodec ?? null,
          item.pixelFormat ?? null,
          item.rootId ?? 'legacy',
          item.relativePath ?? item.path,
          item.libraryKind ?? 'other',
          item.collectionTitle ?? item.filename,
          item.policyEnabled === true ? 1 : 0,
          item.playbackOverride === null ||
            item.playbackOverride === undefined
            ? null
            : item.playbackOverride
              ? 1
              : 0,
          (item.rootAvailable ?? true) ? 1 : 0,
          item.collectionId ?? null,
          item.seasonNumber ?? null,
          item.episodeNumber ?? null,
          item.episodeTitle ?? null
        )
        if (item.collectionId != null) {
          linkedCollectionIds.add(item.collectionId)
        }
      }
      // See upsertMedia: collection approval is authoritative over the
      // indexer's earlier snapshot, including when approval happened while a
      // long-running batch was probing files.
      for (const collectionId of linkedCollectionIds) {
        this.syncCollectionEligibility(collectionId)
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

  async listMissingAudioProbe(limit: number): Promise<MediaItem[]> {
    if (!this.db) throw new Error('Repository not initialized')
    const bounded = Math.max(1, Math.min(500, Math.floor(limit)))
    const rows = this.db
      .prepare(
        `SELECT ${MEDIA_COLUMNS} FROM media
         WHERE (has_audio IS NULL OR pixel_format IS NULL) AND root_available = 1
         ORDER BY id LIMIT ?`
      )
      .all(bounded) as Array<Record<string, unknown>>
    return rows.map((row) => this.rowToMediaItem(row))
  }

  async updateAudioProbe(
    id: number,
    hasAudio: boolean,
    audioCodec: string | null
  ): Promise<void> {
    if (!this.db) throw new Error('Repository not initialized')
    this.db
      .prepare('UPDATE media SET has_audio = ?, audio_codec = ? WHERE id = ?')
      .run(hasAudio ? 1 : 0, audioCodec, id)
  }
}
