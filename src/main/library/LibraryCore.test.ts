import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../database/createDatabase';
import { MetadataService } from './MetadataService';
import { createLibraryService } from './LibraryService';
import type { ParsedTrackMetadata, ScannedAudioFile } from './libraryTypes';

const tempRoots: string[] = [];
const cleanupCallbacks: Array<() => void> = [];

const makeTempRoot = (): string => {
  const root = join(tmpdir(), `echo-next-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  tempRoots.push(root);
  return root;
};

const writeAudioFile = (folder: string, name: string, mtime = new Date('2024-01-01T00:00:00.000Z')): string => {
  const filePath = join(folder, name);
  writeFileSync(filePath, `fake audio ${name}`);
  utimesSync(filePath, mtime, mtime);
  return filePath;
};

const baseMetadata = (overrides: Partial<ParsedTrackMetadata> = {}): ParsedTrackMetadata => ({
  title: 'Embedded Title',
  artist: 'Embedded Artist',
  album: 'Embedded Album',
  albumArtist: 'Embedded Album Artist',
  trackNo: 1,
  discNo: 1,
  year: 2024,
  duration: 180,
  codec: 'FLAC',
  sampleRate: 96000,
  bitDepth: 24,
  bitrate: 1600000,
  fieldSources: {
    title: 'embedded',
    artist: 'embedded',
    album: 'embedded',
    albumArtist: 'embedded',
    trackNo: 'embedded',
    discNo: 'embedded',
    year: 'embedded',
    duration: 'technical',
    codec: 'technical',
    sampleRate: 'technical',
    bitDepth: 'technical',
    bitrate: 'technical',
  },
  ...overrides,
});

class MockMetadataService extends MetadataService {
  readonly calls: string[] = [];
  readonly overrides = new Map<string, Partial<ParsedTrackMetadata>>();
  readonly failures = new Set<string>();

  async read(file: ScannedAudioFile): Promise<ParsedTrackMetadata> {
    this.calls.push(file.path);
    if (this.failures.has(file.path)) {
      throw new Error('metadata boom');
    }

    return baseMetadata(this.overrides.get(file.path));
  }
}

const createHarness = () => {
  const root = makeTempRoot();
  const folder = join(root, 'music');
  mkdirSync(folder, { recursive: true });
  const metadataService = new MockMetadataService();
  const databasePath = join(root, 'library.sqlite');
  const coverCacheDir = join(root, 'cover-cache');
  const service = createLibraryService(databasePath, {
    metadataService,
    coverCacheDir,
  });
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) {
      return;
    }

    cleanedUp = true;
    try {
      service.close();
    } catch {
      // Some tests intentionally close and reopen the service to simulate app restart.
    }
    rmSync(root, { recursive: true, force: true });
  };

  cleanupCallbacks.push(cleanup);

  return {
    root,
    folder,
    databasePath,
    coverCacheDir,
    metadataService,
    service,
    async scanFolder() {
      const [libraryFolder] = service.getFolders();
      const job = service.scanFolder(libraryFolder.id);
      await service.waitForScan(job.id);
      return service.getScanStatus(job.id);
    },
    addFolder() {
      return service.addFolder(folder);
    },
    cleanup() {
      cleanup();
    },
  };
};

afterEach(() => {
  for (const cleanup of cleanupCallbacks.splice(0)) {
    cleanup();
  }

  for (const root of tempRoots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // SQLite WAL handles can linger briefly after an assertion failure on Windows.
    }
  }
});

describe('Library Core', () => {
  it('migration can initialize database and run repeatedly', () => {
    const root = makeTempRoot();
    const databasePath = join(root, 'library.sqlite');
    const database = createDatabase(databasePath);
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
    const indexes = database.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((row) => row.name);

    expect(tables).toEqual(expect.arrayContaining(['folders', 'tracks', 'albums', 'album_tracks', 'artists', 'covers', 'scan_jobs']));
    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx_tracks_path',
        'idx_tracks_folder_id',
        'idx_tracks_title',
        'idx_tracks_artist',
        'idx_tracks_album',
        'idx_albums_album_key',
        'idx_album_tracks_album_id',
        'idx_folders_path',
      ]),
    );

    database.close();
    const reopened = createDatabase(databasePath);
    const migrationRows = reopened.prepare('SELECT id FROM schema_migrations ORDER BY id').all();

    expect(migrationRows.map((row) => Number(row.id))).toEqual([1, 2]);
    reopened.close();
  });

  it('can add folder', () => {
    const harness = createHarness();
    const folder = harness.addFolder();

    expect(folder.path).toBe(harness.folder);
    expect(harness.service.getFolders()).toHaveLength(1);
    harness.cleanup();
  });

  it('addFolder persists across service restart', () => {
    const harness = createHarness();
    harness.addFolder();
    harness.service.close();

    const restarted = createLibraryService(harness.databasePath, {
      metadataService: new MockMetadataService(),
      coverCacheDir: harness.coverCacheDir,
    });

    expect(restarted.getFolders()).toHaveLength(1);
    expect(restarted.getFolders()[0].path).toBe(harness.folder);
    restarted.close();
    harness.cleanup();
  });

  it('path + size + mtime unchanged skips metadata parse', async () => {
    const harness = createHarness();
    writeAudioFile(harness.folder, 'Artist - Song.flac');
    harness.addFolder();

    await harness.scanFolder();
    const secondScan = await harness.scanFolder();

    expect(harness.metadataService.calls).toHaveLength(1);
    expect(secondScan.skippedFiles).toBe(1);
    harness.cleanup();
  });

  it('changed mtime or size triggers reparse', async () => {
    const harness = createHarness();
    const filePath = writeAudioFile(harness.folder, 'Artist - Song.flac');
    harness.addFolder();

    await harness.scanFolder();
    writeFileSync(filePath, 'fake audio with a changed size');
    utimesSync(filePath, new Date('2024-01-02T00:00:00.000Z'), new Date('2024-01-02T00:00:00.000Z'));
    const secondScan = await harness.scanFolder();

    expect(harness.metadataService.calls).toHaveLength(2);
    expect(secondScan.updatedTracks).toBe(1);
    harness.cleanup();
  });

  it('deleted files are removed from the library on the next scan', async () => {
    const harness = createHarness();
    const filePath = writeAudioFile(harness.folder, 'Artist - Removed.flac');
    harness.addFolder();

    await harness.scanFolder();
    rmSync(filePath);
    const secondScan = await harness.scanFolder();

    expect(secondScan.removedTracks).toBe(1);
    expect(harness.service.getTracks({ pageSize: 10 }).total).toBe(0);
    harness.cleanup();
  });

  it('scan job reports progress phases and per-file metadata errors', async () => {
    const harness = createHarness();
    writeAudioFile(harness.folder, 'Good.flac');
    const badFile = writeAudioFile(harness.folder, 'Bad.flac');
    harness.metadataService.failures.add(badFile);
    harness.addFolder();

    const status = await harness.scanFolder();

    expect(status.status).toBe('completed');
    expect(status.phase).toBe('finished');
    expect(status.totalFiles).toBe(2);
    expect(status.processedFiles).toBe(2);
    expect(status.errorCount).toBe(1);
    expect(status.errors[0]).toContain('metadata boom');
    expect(harness.service.getTracks({ pageSize: 10 }).total).toBe(1);
    harness.cleanup();
  });

  it('metadata embedded title is not overwritten by filename fallback', () => {
    const metadataService = new MetadataService();
    const parsed = metadataService.normalize('Filename Artist - Filename Title.flac', {
      common: {
        title: 'Embedded Title',
        artist: 'Embedded Artist',
        album: 'Embedded Album',
      },
      format: {},
    } as Parameters<MetadataService['normalize']>[1]);

    expect(parsed.title).toBe('Embedded Title');
    expect(parsed.artist).toBe('Embedded Artist');
    expect(parsed.album).toBe('Embedded Album');
    expect(parsed.fieldSources.title).toBe('embedded');
  });

  it('embedded artist prevents Unknown Artist fallback', () => {
    const metadataService = new MetadataService();
    const parsed = metadataService.normalize('No Artist In Name.flac', {
      common: {
        artist: 'Embedded Artist',
      },
      format: {},
    } as Parameters<MetadataService['normalize']>[1]);

    expect(parsed.artist).toBe('Embedded Artist');
    expect(parsed.artist).not.toBe('Unknown Artist');
    expect(parsed.fieldSources.artist).toBe('embedded');
  });

  it('embedded album is not overwritten by folder inference', () => {
    const metadataService = new MetadataService();
    const parsed = metadataService.normalize(join('Folder Album', 'Artist - Song.flac'), {
      common: {
        album: 'Embedded Album',
      },
      format: {},
    } as Parameters<MetadataService['normalize']>[1]);

    expect(parsed.album).toBe('Embedded Album');
    expect(parsed.fieldSources.album).toBe('embedded');
  });

  it('album grouping same albumArtist merges', async () => {
    const harness = createHarness();
    const first = writeAudioFile(harness.folder, 'A.flac');
    const second = writeAudioFile(harness.folder, 'B.flac');
    harness.metadataService.overrides.set(first, baseMetadata({ title: 'A', album: 'Same Album', albumArtist: 'Same Artist' }));
    harness.metadataService.overrides.set(second, baseMetadata({ title: 'B', album: 'Same Album', albumArtist: 'Same Artist' }));
    harness.addFolder();

    await harness.scanFolder();
    const albums = harness.service.getAlbums({ pageSize: 10 });

    expect(albums.total).toBe(1);
    expect(albums.items[0].trackCount).toBe(2);
    harness.cleanup();
  });

  it('album grouping different albumArtist does not merge', async () => {
    const harness = createHarness();
    const first = writeAudioFile(harness.folder, 'A.flac');
    const second = writeAudioFile(harness.folder, 'B.flac');
    harness.metadataService.overrides.set(first, baseMetadata({ title: 'A', album: 'Same Album', albumArtist: 'Artist One' }));
    harness.metadataService.overrides.set(second, baseMetadata({ title: 'B', album: 'Same Album', albumArtist: 'Artist Two' }));
    harness.addFolder();

    await harness.scanFolder();
    const albums = harness.service.getAlbums({ pageSize: 10 });

    expect(albums.total).toBe(2);
    harness.cleanup();
  });

  it('empty album values do not merge into one giant Unknown Album', async () => {
    const harness = createHarness();
    const first = writeAudioFile(harness.folder, 'Loose A.flac');
    const second = writeAudioFile(harness.folder, 'Loose B.flac');
    harness.metadataService.overrides.set(first, baseMetadata({ title: 'Loose A', album: '', albumArtist: '' }));
    harness.metadataService.overrides.set(second, baseMetadata({ title: 'Loose B', album: '', albumArtist: '' }));
    harness.addFolder();

    await harness.scanFolder();
    const albums = harness.service.getAlbums({ pageSize: 10 });

    expect(albums.total).toBe(2);
    harness.cleanup();
  });

  it('albums persist and can be read after restart without metadata parsing', async () => {
    const harness = createHarness();
    writeAudioFile(harness.folder, 'A.flac');
    writeAudioFile(harness.folder, 'B.flac');
    harness.addFolder();

    await harness.scanFolder();
    harness.service.close();

    const restartedMetadata = new MockMetadataService();
    const restarted = createLibraryService(harness.databasePath, {
      metadataService: restartedMetadata,
      coverCacheDir: harness.coverCacheDir,
    });
    const albums = restarted.getAlbums({ pageSize: 10 });

    expect(albums.total).toBe(1);
    expect(albums.items[0].trackCount).toBe(2);
    expect(restartedMetadata.calls).toHaveLength(0);
    restarted.close();
    harness.cleanup();
  });

  it('getTracks returns paginated data', async () => {
    const harness = createHarness();
    writeAudioFile(harness.folder, 'A.flac');
    writeAudioFile(harness.folder, 'B.flac');
    writeAudioFile(harness.folder, 'C.flac');
    harness.addFolder();

    await harness.scanFolder();
    const firstPage = harness.service.getTracks({ page: 1, pageSize: 2 });
    const secondPage = harness.service.getTracks({ page: 2, pageSize: 2 });

    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.hasMore).toBe(true);
    expect(secondPage.items).toHaveLength(1);
    harness.cleanup();
  });

  it('getAlbumTracks returns paginated tracks from persisted album_tracks', async () => {
    const harness = createHarness();
    writeAudioFile(harness.folder, 'A.flac');
    writeAudioFile(harness.folder, 'B.flac');
    harness.addFolder();

    await harness.scanFolder();
    const [album] = harness.service.getAlbums({ pageSize: 1 }).items;
    const firstPage = harness.service.getAlbumTracks(album.id, { page: 1, pageSize: 1 });
    const secondPage = harness.service.getAlbumTracks(album.id, { page: 2, pageSize: 1 });

    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.hasMore).toBe(true);
    expect(secondPage.items).toHaveLength(1);
    harness.cleanup();
  });

  it('list API does not return full cover', async () => {
    const harness = createHarness();
    const filePath = writeAudioFile(harness.folder, 'Cover.flac');
    harness.metadataService.overrides.set(
      filePath,
      baseMetadata({
        embeddedCover: {
          data: new Uint8Array([1, 2, 3, 4]),
          mimeType: 'image/png',
        },
      }),
    );
    harness.addFolder();

    await harness.scanFolder();
    const [track] = harness.service.getTracks({ pageSize: 1 }).items;

    expect(track).toHaveProperty('coverThumb');
    expect(track).not.toHaveProperty('coverLarge');
    expect(track).not.toHaveProperty('coverOriginal');
    expect(JSON.stringify(track)).not.toContain('base64');
    harness.cleanup();
  });

  it('embedded cover wins over folder/default cover', async () => {
    const harness = createHarness();
    const filePath = writeAudioFile(harness.folder, 'Cover Priority.flac');
    writeFileSync(join(harness.folder, 'cover.jpg'), new Uint8Array([9, 9, 9]));
    harness.metadataService.overrides.set(
      filePath,
      baseMetadata({
        embeddedCover: {
          data: new Uint8Array([1, 2, 3, 4]),
          mimeType: 'image/png',
        },
      }),
    );
    harness.addFolder();

    await harness.scanFolder();
    const [track] = harness.service.getTracks({ pageSize: 1 }).items;
    harness.service.close();
    const database = createDatabase(harness.databasePath);
    const cover = database.prepare('SELECT source_type, cover_thumb FROM covers WHERE id = ?').get(track.coverId);

    expect(cover?.source_type).toBe('embedded');
    expect(typeof cover?.cover_thumb).toBe('string');
    expect(track.coverThumb).toContain('file://');
    database.close();
    harness.cleanup();
  });
});
