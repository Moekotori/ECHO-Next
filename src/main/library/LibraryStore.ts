import { randomUUID } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { EchoDatabase } from '../database/createDatabase';
import type { AlbumService } from './AlbumService';
import type {
  CoverResult,
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

type DbRow = Record<string, unknown>;

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

const textOrNull = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);
const numberOrNull = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

export class LibraryStore {
  constructor(private readonly database: EchoDatabase) {}

  transaction<T>(work: () => T): T {
    if (this.database.inTransaction) {
      return work();
    }

    return this.database.transaction(work)();
  }

  addFolder(folderPath: string): LibraryFolder {
    const normalizedPath = resolve(folderPath);
    const existing = this.getRow('SELECT * FROM folders WHERE path = ?', normalizedPath);
    const timestamp = nowIso();

    if (existing) {
      this.run('UPDATE folders SET status = ?, enabled = ?, updated_at = ? WHERE id = ?', 'active', 1, timestamp, existing.id);
      return this.mapFolder({ ...existing, status: 'active', enabled: 1, updated_at: timestamp });
    }

    const id = randomUUID();
    const name = basename(normalizedPath) || normalizedPath;

    this.run(
      `INSERT INTO folders (id, path, name, status, enabled, last_scan_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      normalizedPath,
      name,
      'active',
      1,
      null,
      timestamp,
      timestamp,
    );

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
    return this.allRows(
      "SELECT * FROM folders WHERE enabled = 1 AND status != 'removed' ORDER BY path COLLATE NOCASE",
    ).map((row) => this.mapFolder(row));
  }

  getFolder(folderId: string): LibraryFolder | null {
    const row = this.getRow("SELECT * FROM folders WHERE id = ? AND enabled = 1 AND status != 'removed'", folderId);
    return row ? this.mapFolder(row) : null;
  }

  removeFolder(folderId: string): void {
    this.transaction(() => {
      const timestamp = nowIso();
      this.run('UPDATE folders SET status = ?, enabled = ?, updated_at = ? WHERE id = ?', 'removed', 0, timestamp, folderId);
      this.run('DELETE FROM tracks WHERE folder_id = ?', folderId);
      this.run('DELETE FROM scan_jobs WHERE folder_id = ?', folderId);
      this.run('DELETE FROM album_tracks');
      this.run('DELETE FROM albums');
      this.refreshArtists();
    });
  }

  createScanJob(folderId: string): LibraryScanStatus {
    const id = randomUUID();
    const timestamp = nowIso();

    this.run(
      `INSERT INTO scan_jobs (
        id, folder_id, status, phase, errors_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      folderId,
      'queued',
      'queued',
      '[]',
      timestamp,
      timestamp,
    );

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

    this.run(
      `UPDATE scan_jobs SET
        status = ?,
        phase = ?,
        discovered_count = ?,
        parsed_count = ?,
        skipped_count = ?,
        cover_count = ?,
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
      next.status,
      next.phase,
      next.totalFiles,
      next.processedFiles,
      next.skippedFiles,
      update.coverCount ?? current.coverCount ?? 0,
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
    const row = this.getRow('SELECT * FROM scan_jobs WHERE id = ?', jobId);
    return row ? this.mapScanJob(row) : null;
  }

  isScanCancelled(jobId: string): boolean {
    const row = this.getRow('SELECT cancel_requested FROM scan_jobs WHERE id = ?', jobId);
    return Number(row?.cancel_requested ?? 0) === 1;
  }

  finishFolderScan(folderId: string, timestamp = nowIso()): void {
    this.run('UPDATE folders SET last_scan_at = ?, updated_at = ? WHERE id = ?', timestamp, timestamp, folderId);
  }

  findTrackFingerprint(filePath: string): StoredTrackFingerprint | null {
    const row = this.getRow('SELECT id, size_bytes, mtime_ms FROM tracks WHERE path = ? AND missing = 0', resolve(filePath));

    if (!row) {
      return null;
    }

    return {
      id: String(row.id),
      sizeBytes: Number(row.size_bytes),
      mtimeMs: Number(row.mtime_ms),
    };
  }

  markTracksMissingFromFolder(folderId: string, discoveredPaths: string[], timestamp = nowIso()): number {
    const normalizedPaths = new Set(discoveredPaths.map((filePath) => resolve(filePath)));
    const existingRows = this.allRows('SELECT id, path FROM tracks WHERE folder_id = ? AND missing = 0', folderId);
    const missingIds = existingRows.filter((row) => !normalizedPaths.has(String(row.path))).map((row) => String(row.id));

    let changed = 0;

    for (const id of missingIds) {
      const result = this.run('UPDATE tracks SET missing = 1, updated_at = ? WHERE id = ?', timestamp, id);
      changed += Number(result.changes ?? 0);
    }

    return changed;
  }

  removeTracksMissingFromFolder(folderId: string, discoveredPaths: string[]): number {
    return this.markTracksMissingFromFolder(folderId, discoveredPaths);
  }

  upsertCover(result: CoverResult, now = nowIso()): string | null {
    const existing = this.getRow('SELECT id FROM covers WHERE source_hash = ?', result.sourceHash);

    if (textOrNull(existing?.id)) {
      this.run(
        `UPDATE covers SET
          source_type = ?,
          mime_type = ?,
          thumb_path = ?,
          large_path = ?,
          original_ref = ?,
          cover_thumb = ?,
          cover_large = ?,
          cover_original = ?,
          updated_at = ?
        WHERE id = ?`,
        result.source,
        result.mimeType,
        result.thumbPath,
        result.largePath,
        result.originalRef,
        result.thumbPath,
        result.largePath,
        result.originalRef,
        now,
        existing?.id,
      );
      return String(existing?.id);
    }

    const id = randomUUID();
    this.run(
      `INSERT INTO covers (
        id, source_type, source_hash, mime_type,
        thumb_path, large_path, original_ref,
        cover_thumb, cover_large, cover_original,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      result.source,
      result.sourceHash,
      result.mimeType,
      result.thumbPath,
      result.largePath,
      result.originalRef,
      result.thumbPath,
      result.largePath,
      result.originalRef,
      now,
      now,
    );

    return id;
  }

  upsertTrack(track: TrackWrite): 'added' | 'updated' {
    const existing = this.getRow('SELECT id, created_at FROM tracks WHERE path = ?', resolve(track.path));
    const createdAt = textOrNull(existing?.created_at) ?? track.createdAt ?? track.updatedAt;
    const id = textOrNull(existing?.id) ?? track.id;

    this.run(
      `INSERT INTO tracks (
        id, path, folder_id, size_bytes, mtime_ms, title, artist, album, album_artist,
        track_no, disc_no, year, genre, duration, codec, sample_rate, bit_depth, bitrate,
        cover_id, metadata_status, field_sources_json, missing, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        genre = excluded.genre,
        duration = excluded.duration,
        codec = excluded.codec,
        sample_rate = excluded.sample_rate,
        bit_depth = excluded.bit_depth,
        bitrate = excluded.bitrate,
        cover_id = excluded.cover_id,
        metadata_status = excluded.metadata_status,
        field_sources_json = excluded.field_sources_json,
        missing = 0,
        updated_at = excluded.updated_at`,
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
      track.genre,
      track.duration,
      track.codec,
      track.sampleRate,
      track.bitDepth,
      track.bitrate,
      track.coverId,
      track.metadataStatus ?? 'ok',
      JSON.stringify(track.fieldSources),
      0,
      createdAt,
      track.updatedAt,
    );

    return existing ? 'updated' : 'added';
  }

  refreshArtists(): void {
    const timestamp = nowIso();
    this.run('DELETE FROM artists');
    const trackRows = this.allRows(
      `SELECT artist AS name, COUNT(*) AS track_count
       FROM tracks
       WHERE missing = 0 AND artist IS NOT NULL AND TRIM(artist) != ''
       GROUP BY artist`,
    );
    const albumRows = this.allRows(
      `SELECT album_artist AS name, COUNT(*) AS album_count
       FROM albums
       WHERE album_artist IS NOT NULL AND TRIM(album_artist) != ''
       GROUP BY album_artist`,
    );
    const stats = new Map<string, { name: string; trackCount: number; albumCount: number }>();

    for (const row of trackRows) {
      const name = String(row.name ?? '').trim();
      if (!name) {
        continue;
      }

      stats.set(name.toLocaleLowerCase(), {
        name,
        trackCount: Number(row.track_count ?? 0),
        albumCount: 0,
      });
    }

    for (const row of albumRows) {
      const name = String(row.name ?? '').trim();
      if (!name) {
        continue;
      }

      const key = name.toLocaleLowerCase();
      const current = stats.get(key) ?? { name, trackCount: 0, albumCount: 0 };
      current.albumCount = Number(row.album_count ?? 0);
      stats.set(key, current);
    }

    for (const artist of stats.values()) {
      this.run(
        `INSERT OR REPLACE INTO artists (
          id, artist_key, name, sort_name, role, track_count, album_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        randomUUID(),
        artist.name.toLocaleLowerCase(),
        artist.name,
        artist.name.toLocaleLowerCase(),
        'track',
        artist.trackCount,
        artist.albumCount,
        timestamp,
        timestamp,
      );
    }
  }

  refreshAlbums(albumService: AlbumService, now = nowIso()): void {
    this.run('DELETE FROM album_tracks');
    this.run('DELETE FROM albums');

    const tracks = this.allRows(
      `SELECT id, path, artist, album, album_artist, year, duration, cover_id, disc_no, track_no
       FROM tracks
       WHERE missing = 0
       ORDER BY album_artist COLLATE NOCASE, album COLLATE NOCASE, disc_no, track_no, title COLLATE NOCASE`,
    );

    const albumIdsByKey = new Map<string, string>();
    const albumStats = new Map<
      string,
      {
        id: string;
        albumKey: string;
        title: string;
        albumArtist: string;
        year: number | null;
        trackCount: number;
        duration: number;
        coverId: string | null;
      }
    >();
    const albumTrackLinks: Array<{ albumId: string; trackId: string; discNo: number | null; trackNo: number | null; position: number }> = [];

    tracks.forEach((track, index) => {
      const trackId = String(track.id);
      const title = String(track.album || '');
      const albumArtist = String(track.album_artist || '');
      const year = numberOrNull(track.year);
      const albumKey = albumService.makeAlbumKey({
        albumTitle: title,
        albumArtist,
        fallbackArtist: String(track.artist || ''),
        year,
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
          year,
          trackCount: 0,
          duration: 0,
          coverId: textOrNull(track.cover_id),
        };

      stats.trackCount += 1;
      stats.duration += Number(track.duration ?? 0);
      stats.coverId = stats.coverId ?? textOrNull(track.cover_id);
      albumStats.set(albumKey, stats);

      albumTrackLinks.push({
        albumId,
        trackId,
        discNo: numberOrNull(track.disc_no),
        trackNo: numberOrNull(track.track_no),
        position: index,
      });
    });

    for (const album of albumStats.values()) {
      this.run(
        `INSERT INTO albums (
          id, album_key, title, album_artist, year, cover_id, track_count, duration, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        album.id,
        album.albumKey,
        album.title,
        album.albumArtist,
        album.year,
        album.coverId,
        album.trackCount,
        album.duration,
        now,
        now,
      );
    }

    for (const link of albumTrackLinks) {
      this.run(
        'INSERT INTO album_tracks (album_id, track_id, disc_no, track_no, position) VALUES (?, ?, ?, ?, ?)',
        link.albumId,
        link.trackId,
        link.discNo,
        link.trackNo,
        link.position,
      );
    }
  }

  getTracks(query?: LibraryPageQuery): LibraryPage<LibraryTrack> {
    const { page, pageSize, search, sort } = pageFromQuery(query);
    const offset = (page - 1) * pageSize;
    const whereSql = search
      ? "WHERE tracks.missing = 0 AND (tracks.title LIKE ? ESCAPE '\\' OR tracks.artist LIKE ? ESCAPE '\\' OR tracks.album LIKE ? ESCAPE '\\')"
      : 'WHERE tracks.missing = 0';
    const searchParams = search ? [likeSearch(search), likeSearch(search), likeSearch(search)] : [];
    const orderSql = this.trackOrderSql(sort);
    const totalRow = this.getRow(`SELECT COUNT(*) AS total FROM tracks ${whereSql}`, ...searchParams);
    const rows = this.allRows(
      `SELECT
        tracks.id, tracks.path, tracks.title, tracks.artist, tracks.album, tracks.album_artist,
        tracks.track_no, tracks.disc_no, tracks.year, tracks.genre,
        tracks.duration, tracks.codec, tracks.sample_rate, tracks.bit_depth, tracks.bitrate,
        tracks.cover_id, tracks.metadata_status, tracks.field_sources_json,
        COALESCE(covers.thumb_path, covers.cover_thumb) AS cover_thumb
      FROM tracks
      LEFT JOIN covers ON covers.id = tracks.cover_id
      ${whereSql}
      ${orderSql}
      LIMIT ? OFFSET ?`,
      ...searchParams,
      pageSize,
      offset,
    );
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
    const totalRow = this.getRow(`SELECT COUNT(*) AS total FROM albums ${whereSql}`, ...searchParams);
    const rows = this.allRows(
      `SELECT
        albums.id, albums.album_key, albums.title, albums.album_artist, albums.year, albums.track_count,
        albums.duration, albums.cover_id, COALESCE(covers.thumb_path, covers.cover_thumb) AS cover_thumb
      FROM albums
      LEFT JOIN covers ON covers.id = albums.cover_id
      ${whereSql}
      ${orderSql}
      LIMIT ? OFFSET ?`,
      ...searchParams,
      pageSize,
      offset,
    );
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
    const totalRow = this.getRow('SELECT COUNT(*) AS total FROM album_tracks WHERE album_id = ?', albumId);
    const rows = this.allRows(
      `SELECT
        tracks.id, tracks.path, tracks.title, tracks.artist, tracks.album, tracks.album_artist,
        tracks.track_no, tracks.disc_no, tracks.year, tracks.genre,
        tracks.duration, tracks.codec, tracks.sample_rate, tracks.bit_depth, tracks.bitrate,
        tracks.cover_id, tracks.metadata_status, tracks.field_sources_json,
        COALESCE(covers.thumb_path, covers.cover_thumb) AS cover_thumb
      FROM album_tracks
      INNER JOIN tracks ON tracks.id = album_tracks.track_id
      LEFT JOIN covers ON covers.id = tracks.cover_id
      WHERE album_tracks.album_id = ? AND tracks.missing = 0
      ORDER BY album_tracks.position ASC
      LIMIT ? OFFSET ?`,
      albumId,
      pageSize,
      offset,
    );
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
    const songCount = Number(this.getRow('SELECT COUNT(*) AS total FROM tracks WHERE missing = 0')?.total ?? 0);
    const albumCount = Number(this.getRow('SELECT COUNT(*) AS total FROM albums')?.total ?? 0);
    const artistCount = Number(this.getRow('SELECT COUNT(*) AS total FROM artists')?.total ?? 0);
    const folderCount = Number(
      this.getRow("SELECT COUNT(*) AS total FROM folders WHERE enabled = 1 AND status != 'removed'")?.total ?? 0,
    );
    const duration = Number(this.getRow('SELECT COALESCE(SUM(duration), 0) AS total FROM tracks WHERE missing = 0')?.total ?? 0);
    const scanRow = this.getRow("SELECT finished_at FROM scan_jobs WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1");

    return {
      songCount,
      albumCount,
      artistCount,
      folderCount,
      totalDuration: duration,
      lastScanAt: textOrNull(scanRow?.finished_at),
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

  private mapFolder(row: DbRow): LibraryFolder {
    return {
      id: String(row.id),
      path: String(row.path),
      name: String(row.name),
      status: Number(row.enabled ?? 1) === 0 || row.status === 'removed' ? 'removed' : 'active',
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private mapScanJob(row: DbRow): LibraryScanStatus {
    return {
      id: String(row.id),
      folderId: String(row.folder_id),
      status: this.mapScanStatus(row.status),
      phase: this.mapScanPhase(row.phase),
      totalFiles: Number(row.discovered_count ?? row.total_files ?? 0),
      processedFiles: Number(row.parsed_count ?? row.processed_files ?? 0),
      skippedFiles: Number(row.skipped_count ?? row.skipped_files ?? 0),
      addedTracks: Number(row.added_tracks ?? 0),
      updatedTracks: Number(row.updated_tracks ?? 0),
      removedTracks: Number(row.removed_tracks ?? 0),
      coverCount: Number(row.cover_count ?? 0),
      errorCount: Number(row.error_count ?? 0),
      errors: parseErrors(row.errors_json),
      startedAt: textOrNull(row.started_at),
      finishedAt: textOrNull(row.finished_at),
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
      value === 'discovering' ||
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

  private mapTrack(row: DbRow): LibraryTrack {
    return {
      id: String(row.id),
      path: String(row.path),
      title: String(row.title),
      artist: String(row.artist),
      album: String(row.album),
      albumArtist: String(row.album_artist),
      trackNo: numberOrNull(row.track_no),
      discNo: numberOrNull(row.disc_no),
      year: numberOrNull(row.year),
      genre: textOrNull(row.genre),
      duration: Number(row.duration ?? 0),
      codec: textOrNull(row.codec),
      sampleRate: numberOrNull(row.sample_rate),
      bitDepth: numberOrNull(row.bit_depth),
      bitrate: numberOrNull(row.bitrate),
      coverId: textOrNull(row.cover_id),
      coverThumb: this.toFileUrl(row.cover_thumb),
      metadataStatus: textOrNull(row.metadata_status) ?? 'ok',
      fieldSources: parseJsonObject(row.field_sources_json),
    };
  }

  private mapAlbum(row: DbRow): LibraryAlbum {
    return {
      id: String(row.id),
      albumKey: String(row.album_key),
      title: String(row.title),
      albumArtist: String(row.album_artist),
      year: numberOrNull(row.year),
      trackCount: Number(row.track_count ?? 0),
      duration: Number(row.duration ?? 0),
      coverId: textOrNull(row.cover_id),
      coverThumb: this.toFileUrl(row.cover_thumb),
    };
  }

  private toFileUrl(value: unknown): string | null {
    if (typeof value !== 'string' || !value) {
      return null;
    }

    return pathToFileURL(value).toString();
  }

  private getRow(sql: string, ...params: unknown[]): DbRow | null {
    return this.database.prepare<unknown[], DbRow>(sql).get(...params) ?? null;
  }

  private allRows(sql: string, ...params: unknown[]): DbRow[] {
    return this.database.prepare<unknown[], DbRow>(sql).all(...params);
  }

  private run(sql: string, ...params: unknown[]): { changes: number } {
    return this.database.prepare(sql).run(...params);
  }
}
