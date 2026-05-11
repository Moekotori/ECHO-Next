import { randomUUID } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import type { AlbumService } from './AlbumService';
import type {
  LibraryAlbum,
  LibraryFolder,
  LibraryPage,
  LibraryPageQuery,
  LibraryScanStatus,
  LibrarySummary,
  LibraryTrack,
  ScanJobUpdate,
  StoredTrackFingerprint,
  TrackWrite,
} from './libraryTypes';

const defaultPageSize = 100;
const maxPageSize = 500;

const nowIso = (): string => new Date().toISOString();

const pageFromQuery = (query?: LibraryPageQuery): { page: number; pageSize: number; search: string; sort: string } => ({
  page: Math.max(1, Math.floor(Number(query?.page ?? 1))),
  pageSize: Math.min(maxPageSize, Math.max(1, Math.floor(Number(query?.pageSize ?? defaultPageSize)))),
  search: typeof query?.search === 'string' ? query.search.trim() : '',
  sort: query?.sort ?? 'title',
});

const likeSearch = (search: string): string => `%${search.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;

const parseJsonObject = (value: unknown): Record<string, string> => {
  if (typeof value !== 'string') {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
};

const parseErrors = (value: unknown): string[] => {
  if (typeof value !== 'string') {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
};

export class LibraryStore {
  constructor(private readonly database: DatabaseSync) {}

  transaction<T>(work: () => T): T {
    this.database.exec('BEGIN');

    try {
      const result = work();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  addFolder(folderPath: string): LibraryFolder {
    const normalizedPath = resolve(folderPath);
    const existing = this.database.prepare('SELECT * FROM folders WHERE path = ?').get(normalizedPath);
    const timestamp = nowIso();

    if (existing) {
      this.database
        .prepare('UPDATE folders SET status = ?, updated_at = ? WHERE id = ?')
        .run('active', timestamp, existing.id);
      return this.mapFolder({ ...existing, status: 'active', updated_at: timestamp });
    }

    const id = randomUUID();
    const name = basename(normalizedPath) || normalizedPath;

    this.database
      .prepare(
        `INSERT INTO folders (id, path, name, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, normalizedPath, name, 'active', timestamp, timestamp);

    return {
      id,
      path: normalizedPath,
      name,
      status: 'active',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  getFolders(): LibraryFolder[] {
    return this.database
      .prepare("SELECT * FROM folders WHERE status = 'active' ORDER BY path COLLATE NOCASE")
      .all()
      .map((row) => this.mapFolder(row));
  }

  getFolder(folderId: string): LibraryFolder | null {
    const row = this.database.prepare("SELECT * FROM folders WHERE id = ? AND status = 'active'").get(folderId);
    return row ? this.mapFolder(row) : null;
  }

  removeFolder(folderId: string): void {
    this.transaction(() => {
      const timestamp = nowIso();
      this.database.prepare('UPDATE folders SET status = ?, updated_at = ? WHERE id = ?').run('removed', timestamp, folderId);
      this.database.prepare('DELETE FROM tracks WHERE folder_id = ?').run(folderId);
      this.database.prepare('DELETE FROM scan_jobs WHERE folder_id = ?').run(folderId);
      this.database.exec('DELETE FROM album_tracks');
      this.database.exec('DELETE FROM albums');
      this.refreshArtists();
    });
  }

  createScanJob(folderId: string): LibraryScanStatus {
    const id = randomUUID();
    const timestamp = nowIso();

    this.database
      .prepare(
        `INSERT INTO scan_jobs (
          id, folder_id, status, phase, errors_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, folderId, 'queued', 'queued', '[]', timestamp, timestamp);

    const job = this.getScanJob(id);

    if (!job) {
      throw new Error(`Failed to create scan job ${id}`);
    }

    return job;
  }

  updateScanJob(jobId: string, update: ScanJobUpdate): LibraryScanStatus {
    const current = this.getScanJob(jobId);

    if (!current) {
      throw new Error(`Unknown scan job ${jobId}`);
    }

    const next = {
      ...current,
      ...update,
      errors: update.errors ?? current.errors,
    };

    this.database
      .prepare(
        `UPDATE scan_jobs SET
          status = ?,
          phase = ?,
          total_files = ?,
          processed_files = ?,
          skipped_files = ?,
          added_tracks = ?,
          updated_tracks = ?,
          removed_tracks = ?,
          error_count = ?,
          errors_json = ?,
          cancel_requested = COALESCE(?, cancel_requested),
          started_at = ?,
          finished_at = ?,
          updated_at = ?
        WHERE id = ?`,
      )
      .run(
        next.status,
        next.phase,
        next.totalFiles,
        next.processedFiles,
        next.skippedFiles,
        next.addedTracks,
        next.updatedTracks,
        next.removedTracks,
        next.errors.length,
        JSON.stringify(next.errors),
        typeof update.cancelRequested === 'boolean' ? (update.cancelRequested ? 1 : 0) : null,
        next.startedAt,
        next.finishedAt,
        nowIso(),
        jobId,
      );

    const updated = this.getScanJob(jobId);

    if (!updated) {
      throw new Error(`Failed to update scan job ${jobId}`);
    }

    return updated;
  }

  getScanJob(jobId: string): LibraryScanStatus | null {
    const row = this.database.prepare('SELECT * FROM scan_jobs WHERE id = ?').get(jobId);
    return row ? this.mapScanJob(row) : null;
  }

  isScanCancelled(jobId: string): boolean {
    const row = this.database.prepare('SELECT cancel_requested FROM scan_jobs WHERE id = ?').get(jobId);
    return Number(row?.cancel_requested ?? 0) === 1;
  }

  findTrackFingerprint(filePath: string): StoredTrackFingerprint | null {
    const row = this.database.prepare('SELECT id, size_bytes, mtime_ms FROM tracks WHERE path = ?').get(resolve(filePath));

    if (!row) {
      return null;
    }

    return {
      id: String(row.id),
      sizeBytes: Number(row.size_bytes),
      mtimeMs: Number(row.mtime_ms),
    };
  }

  removeTracksMissingFromFolder(folderId: string, discoveredPaths: string[]): number {
    const normalizedPaths = discoveredPaths.map((filePath) => resolve(filePath));

    if (normalizedPaths.length === 0) {
      const result = this.database.prepare('DELETE FROM tracks WHERE folder_id = ?').run(folderId);
      return Number(result.changes ?? 0);
    }

    const keep = new Set(normalizedPaths);
    const existingRows = this.database.prepare('SELECT id, path FROM tracks WHERE folder_id = ?').all(folderId);
    const missingIds = existingRows
      .filter((row) => !keep.has(String(row.path)))
      .map((row) => String(row.id));

    let removed = 0;
    for (const id of missingIds) {
      const result = this.database.prepare('DELETE FROM tracks WHERE id = ?').run(id);
      removed += Number(result.changes ?? 0);
    }

    return removed;
  }

  upsertTrack(track: TrackWrite): 'added' | 'updated' {
    const existing = this.database.prepare('SELECT id, created_at FROM tracks WHERE path = ?').get(track.path);
    const createdAt = typeof existing?.created_at === 'string' ? existing.created_at : (track.createdAt ?? track.updatedAt);
    const id = typeof existing?.id === 'string' ? existing.id : track.id;

    this.database
      .prepare(
        `INSERT INTO tracks (
          id, path, folder_id, size_bytes, mtime_ms, title, artist, album, album_artist,
          track_no, disc_no, year, duration, codec, sample_rate, bit_depth, bitrate, cover_id, field_sources_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
          folder_id = excluded.folder_id,
          size_bytes = excluded.size_bytes,
          mtime_ms = excluded.mtime_ms,
          title = excluded.title,
          artist = excluded.artist,
          album = excluded.album,
          album_artist = excluded.album_artist,
          track_no = excluded.track_no,
          disc_no = excluded.disc_no,
          year = excluded.year,
          duration = excluded.duration,
          codec = excluded.codec,
          sample_rate = excluded.sample_rate,
          bit_depth = excluded.bit_depth,
          bitrate = excluded.bitrate,
          cover_id = excluded.cover_id,
          field_sources_json = excluded.field_sources_json,
          updated_at = excluded.updated_at`,
      )
      .run(
        id,
        resolve(track.path),
        track.folderId,
        track.sizeBytes,
        track.mtimeMs,
        track.title,
        track.artist,
        track.album,
        track.albumArtist,
        track.trackNo,
        track.discNo,
        track.year,
        track.duration,
        track.codec,
        track.sampleRate,
        track.bitDepth,
        track.bitrate,
        track.coverId,
        JSON.stringify(track.fieldSources),
        createdAt,
        track.updatedAt,
      );

    return existing ? 'updated' : 'added';
  }

  refreshArtists(): void {
    const timestamp = nowIso();
    this.database.exec('DELETE FROM artists');
    const rows = this.database
      .prepare(
        `SELECT artist AS name, 'track' AS role FROM tracks
         UNION
         SELECT album_artist AS name, 'album' AS role FROM tracks`,
      )
      .all();

    for (const row of rows) {
      const name = String(row.name ?? '').trim();

      if (!name) {
        continue;
      }

      const role = String(row.role ?? 'track');
      const artistKey = `${role}:${name.toLocaleLowerCase()}`;

      this.database
        .prepare(
          `INSERT OR IGNORE INTO artists (id, artist_key, name, role, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(randomUUID(), artistKey, name, role, timestamp, timestamp);
    }
  }

  refreshAlbums(albumService: AlbumService, now = nowIso()): void {
    this.database.exec('DELETE FROM album_tracks');
    this.database.exec('DELETE FROM albums');

    const tracks = this.database
      .prepare(
         `SELECT id, path, artist, album, album_artist, year, duration, cover_id
         FROM tracks
         ORDER BY album_artist COLLATE NOCASE, album COLLATE NOCASE, disc_no, track_no, title COLLATE NOCASE`,
      )
      .all();

    const albumIdsByKey = new Map<string, string>();
    const albumStats = new Map<
      string,
      {
        id: string;
        albumKey: string;
        title: string;
        albumArtist: string;
        trackCount: number;
        duration: number;
        coverId: string | null;
      }
    >();
    const albumTrackLinks: Array<{ albumId: string; trackId: string; position: number }> = [];

    tracks.forEach((track, index) => {
      const trackId = String(track.id);
      const title = String(track.album || '');
      const albumArtist = String(track.album_artist || '');
      const albumKey = albumService.makeAlbumKey({
        albumTitle: title,
        albumArtist,
        fallbackArtist: String(track.artist || ''),
        year: typeof track.year === 'number' ? track.year : null,
        filePath: String(track.path),
        trackId,
      });
      const albumId = albumIdsByKey.get(albumKey) ?? randomUUID();

      albumIdsByKey.set(albumKey, albumId);

      const stats =
        albumStats.get(albumKey) ??
        {
          id: albumId,
          albumKey,
          title: title || 'Unknown Album',
          albumArtist: albumArtist || String(track.artist || 'Unknown Artist'),
          trackCount: 0,
          duration: 0,
          coverId: typeof track.cover_id === 'string' ? track.cover_id : null,
        };

      stats.trackCount += 1;
      stats.duration += Number(track.duration ?? 0);
      stats.coverId = stats.coverId ?? (typeof track.cover_id === 'string' ? track.cover_id : null);
      albumStats.set(albumKey, stats);

      albumTrackLinks.push({
        albumId,
        trackId,
        position: index,
      });
    });

    for (const album of albumStats.values()) {
      this.database
        .prepare(
          `INSERT INTO albums (
            id, album_key, title, album_artist, cover_id, track_count, duration, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          album.id,
          album.albumKey,
          album.title,
          album.albumArtist,
          album.coverId,
          album.trackCount,
          album.duration,
          now,
          now,
        );
    }

    for (const link of albumTrackLinks) {
      this.database
        .prepare('INSERT INTO album_tracks (album_id, track_id, position) VALUES (?, ?, ?)')
        .run(link.albumId, link.trackId, link.position);
    }
  }

  getTracks(query?: LibraryPageQuery): LibraryPage<LibraryTrack> {
    const { page, pageSize, search, sort } = pageFromQuery(query);
    const offset = (page - 1) * pageSize;
    const whereSql = search
      ? "WHERE tracks.title LIKE ? ESCAPE '\\' OR tracks.artist LIKE ? ESCAPE '\\' OR tracks.album LIKE ? ESCAPE '\\'"
      : '';
    const searchParams = search ? [likeSearch(search), likeSearch(search), likeSearch(search)] : [];
    const orderSql = this.trackOrderSql(sort);
    const totalRow = this.database.prepare(`SELECT COUNT(*) AS total FROM tracks ${whereSql}`).get(...searchParams);
    const rows = this.database
      .prepare(
        `SELECT
          tracks.id, tracks.path, tracks.title, tracks.artist, tracks.album, tracks.album_artist,
          tracks.track_no, tracks.disc_no, tracks.year,
          tracks.duration, tracks.codec, tracks.sample_rate, tracks.bit_depth, tracks.bitrate,
          tracks.cover_id, tracks.field_sources_json, covers.cover_thumb
        FROM tracks
        LEFT JOIN covers ON covers.id = tracks.cover_id
        ${whereSql}
        ${orderSql}
        LIMIT ? OFFSET ?`,
      )
      .all(...searchParams, pageSize, offset);
    const total = Number(totalRow?.total ?? 0);

    return {
      items: rows.map((row) => this.mapTrack(row)),
      page,
      pageSize,
      total,
      hasMore: offset + rows.length < total,
    };
  }

  getAlbums(query?: LibraryPageQuery): LibraryPage<LibraryAlbum> {
    const { page, pageSize, search, sort } = pageFromQuery(query);
    const offset = (page - 1) * pageSize;
    const whereSql = search ? "WHERE albums.title LIKE ? ESCAPE '\\' OR albums.album_artist LIKE ? ESCAPE '\\'" : '';
    const searchParams = search ? [likeSearch(search), likeSearch(search)] : [];
    const orderSql = this.albumOrderSql(sort);
    const totalRow = this.database.prepare(`SELECT COUNT(*) AS total FROM albums ${whereSql}`).get(...searchParams);
    const rows = this.database
      .prepare(
        `SELECT
          albums.id, albums.album_key, albums.title, albums.album_artist, albums.track_count,
          albums.duration, albums.cover_id, covers.cover_thumb
        FROM albums
        LEFT JOIN covers ON covers.id = albums.cover_id
        ${whereSql}
        ${orderSql}
        LIMIT ? OFFSET ?`,
      )
      .all(...searchParams, pageSize, offset);
    const total = Number(totalRow?.total ?? 0);

    return {
      items: rows.map((row) => this.mapAlbum(row)),
      page,
      pageSize,
      total,
      hasMore: offset + rows.length < total,
    };
  }

  getAlbumTracks(albumId: string, query?: Pick<LibraryPageQuery, 'page' | 'pageSize'>): LibraryPage<LibraryTrack> {
    const { page, pageSize } = pageFromQuery(query);
    const offset = (page - 1) * pageSize;
    const totalRow = this.database
      .prepare('SELECT COUNT(*) AS total FROM album_tracks WHERE album_id = ?')
      .get(albumId);
    const rows = this.database
      .prepare(
        `SELECT
          tracks.id, tracks.path, tracks.title, tracks.artist, tracks.album, tracks.album_artist,
          tracks.track_no, tracks.disc_no, tracks.year,
          tracks.duration, tracks.codec, tracks.sample_rate, tracks.bit_depth, tracks.bitrate,
          tracks.cover_id, tracks.field_sources_json, covers.cover_thumb
        FROM album_tracks
        INNER JOIN tracks ON tracks.id = album_tracks.track_id
        LEFT JOIN covers ON covers.id = tracks.cover_id
        WHERE album_tracks.album_id = ?
        ORDER BY album_tracks.position ASC
        LIMIT ? OFFSET ?`,
      )
      .all(albumId, pageSize, offset);
    const total = Number(totalRow?.total ?? 0);

    return {
      items: rows.map((row) => this.mapTrack(row)),
      page,
      pageSize,
      total,
      hasMore: offset + rows.length < total,
    };
  }

  getSummary(): LibrarySummary {
    const songCount = Number(this.database.prepare('SELECT COUNT(*) AS total FROM tracks').get()?.total ?? 0);
    const albumCount = Number(this.database.prepare('SELECT COUNT(*) AS total FROM albums').get()?.total ?? 0);
    const artistCount = Number(this.database.prepare('SELECT COUNT(*) AS total FROM artists').get()?.total ?? 0);
    const folderCount = Number(
      this.database.prepare("SELECT COUNT(*) AS total FROM folders WHERE status = 'active'").get()?.total ?? 0,
    );
    const duration = Number(this.database.prepare('SELECT COALESCE(SUM(duration), 0) AS total FROM tracks').get()?.total ?? 0);
    const scanRow = this.database
      .prepare("SELECT finished_at FROM scan_jobs WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1")
      .get();

    return {
      songCount,
      albumCount,
      artistCount,
      folderCount,
      totalDuration: duration,
      lastScanAt: typeof scanRow?.finished_at === 'string' ? scanRow.finished_at : null,
    };
  }

  private trackOrderSql(sort: string): string {
    switch (sort) {
      case 'artist':
        return 'ORDER BY tracks.artist COLLATE NOCASE, tracks.title COLLATE NOCASE';
      case 'album':
        return 'ORDER BY tracks.album COLLATE NOCASE, tracks.title COLLATE NOCASE';
      case 'recent':
        return 'ORDER BY tracks.updated_at DESC, tracks.title COLLATE NOCASE';
      case 'title':
      default:
        return 'ORDER BY tracks.title COLLATE NOCASE, tracks.artist COLLATE NOCASE';
    }
  }

  private albumOrderSql(sort: string): string {
    switch (sort) {
      case 'artist':
        return 'ORDER BY albums.album_artist COLLATE NOCASE, albums.title COLLATE NOCASE';
      case 'recent':
        return 'ORDER BY albums.updated_at DESC, albums.title COLLATE NOCASE';
      case 'album':
      case 'title':
      default:
        return 'ORDER BY albums.title COLLATE NOCASE, albums.album_artist COLLATE NOCASE';
    }
  }

  private mapFolder(row: Record<string, unknown>): LibraryFolder {
    return {
      id: String(row.id),
      path: String(row.path),
      name: String(row.name),
      status: row.status === 'removed' ? 'removed' : 'active',
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private mapScanJob(row: Record<string, unknown>): LibraryScanStatus {
    return {
      id: String(row.id),
      folderId: String(row.folder_id),
      status: this.mapScanStatus(row.status),
      phase: this.mapScanPhase(row.phase),
      totalFiles: Number(row.total_files ?? 0),
      processedFiles: Number(row.processed_files ?? 0),
      skippedFiles: Number(row.skipped_files ?? 0),
      addedTracks: Number(row.added_tracks ?? 0),
      updatedTracks: Number(row.updated_tracks ?? 0),
      removedTracks: Number(row.removed_tracks ?? 0),
      errorCount: Number(row.error_count ?? 0),
      errors: parseErrors(row.errors_json),
      startedAt: typeof row.started_at === 'string' ? row.started_at : null,
      finishedAt: typeof row.finished_at === 'string' ? row.finished_at : null,
    };
  }

  private mapScanStatus(value: unknown): LibraryScanStatus['status'] {
    if (
      value === 'queued' ||
      value === 'running' ||
      value === 'completed' ||
      value === 'cancelled' ||
      value === 'failed'
    ) {
      return value;
    }

    return 'failed';
  }

  private mapScanPhase(value: unknown): LibraryScanStatus['phase'] {
    if (
      value === 'queued' ||
      value === 'discovering_files' ||
      value === 'checking_cache' ||
      value === 'reading_metadata' ||
      value === 'extracting_covers' ||
      value === 'grouping_albums' ||
      value === 'writing_database' ||
      value === 'finished' ||
      value === 'failed' ||
      value === 'cancelled'
    ) {
      return value;
    }

    return 'queued';
  }

  private mapTrack(row: Record<string, unknown>): LibraryTrack {
    return {
      id: String(row.id),
      path: String(row.path),
      title: String(row.title),
      artist: String(row.artist),
      album: String(row.album),
      albumArtist: String(row.album_artist),
      trackNo: typeof row.track_no === 'number' ? row.track_no : null,
      discNo: typeof row.disc_no === 'number' ? row.disc_no : null,
      year: typeof row.year === 'number' ? row.year : null,
      duration: Number(row.duration ?? 0),
      codec: typeof row.codec === 'string' ? row.codec : null,
      sampleRate: typeof row.sample_rate === 'number' ? row.sample_rate : null,
      bitDepth: typeof row.bit_depth === 'number' ? row.bit_depth : null,
      bitrate: typeof row.bitrate === 'number' ? row.bitrate : null,
      coverId: typeof row.cover_id === 'string' ? row.cover_id : null,
      coverThumb: this.toFileUrl(row.cover_thumb),
      fieldSources: parseJsonObject(row.field_sources_json),
    };
  }

  private mapAlbum(row: Record<string, unknown>): LibraryAlbum {
    return {
      id: String(row.id),
      albumKey: String(row.album_key),
      title: String(row.title),
      albumArtist: String(row.album_artist),
      trackCount: Number(row.track_count ?? 0),
      duration: Number(row.duration ?? 0),
      coverId: typeof row.cover_id === 'string' ? row.cover_id : null,
      coverThumb: this.toFileUrl(row.cover_thumb),
    };
  }

  private toFileUrl(value: unknown): string | null {
    if (typeof value !== 'string' || !value) {
      return null;
    }

    return pathToFileURL(value).toString();
  }
}
