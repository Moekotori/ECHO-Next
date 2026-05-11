import { statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import electron from 'electron';
import { createDatabase } from '../database/createDatabase';
import { AlbumService } from './AlbumService';
import { CoverService } from './CoverService';
import { LibraryScanner } from './LibraryScanner';
import { LibraryStore } from './LibraryStore';
import { MetadataService } from './MetadataService';
import { ScanJobQueue } from './ScanJobQueue';
import type {
  LibraryAlbum,
  LibraryFolder,
  LibraryPage,
  LibraryPageQuery,
  LibraryScanStatus,
  LibrarySummary,
  LibraryTrack,
} from './libraryTypes';

type LibraryServiceDependencies = {
  scanner?: LibraryScanner;
  metadataService?: MetadataService;
  coverCacheDir?: string;
};

export class LibraryService {
  constructor(
    private readonly store: LibraryStore,
    private readonly scanJobQueue: ScanJobQueue,
    private readonly closeDatabase: () => void,
  ) {}

  addFolder(folderPath: string): LibraryFolder {
    const normalizedPath = resolve(folderPath);
    const pathStat = statSync(normalizedPath);

    if (!pathStat.isDirectory()) {
      throw new Error(`Library folder path is not a directory: ${normalizedPath}`);
    }

    return this.store.addFolder(normalizedPath);
  }

  getFolders(): LibraryFolder[] {
    return this.store.getFolders();
  }

  removeFolder(folderId: string): void {
    this.store.removeFolder(folderId);
  }

  scanFolder(folderId: string): LibraryScanStatus {
    const folder = this.store.getFolder(folderId);

    if (!folder) {
      throw new Error(`Unknown library folder ${folderId}`);
    }

    return this.scanJobQueue.scanFolder(folder);
  }

  getScanStatus(jobId: string): LibraryScanStatus {
    return this.scanJobQueue.getScanStatus(jobId);
  }

  cancelScan(jobId: string): LibraryScanStatus {
    return this.scanJobQueue.cancelScan(jobId);
  }

  getTracks(query?: LibraryPageQuery): LibraryPage<LibraryTrack> {
    return this.store.getTracks(query);
  }

  getAlbums(query?: LibraryPageQuery): LibraryPage<LibraryAlbum> {
    return this.store.getAlbums(query);
  }

  getAlbumTracks(albumId: string, query?: Pick<LibraryPageQuery, 'page' | 'pageSize'>): LibraryPage<LibraryTrack> {
    return this.store.getAlbumTracks(albumId, query);
  }

  getSummary(): LibrarySummary {
    return this.store.getSummary();
  }

  async waitForScan(jobId: string): Promise<void> {
    await this.scanJobQueue.waitForIdle(jobId);
  }

  close(): void {
    this.closeDatabase();
  }
}

export const createLibraryService = (
  databasePath: string,
  dependencies: LibraryServiceDependencies = {},
): LibraryService => {
  const database = createDatabase(databasePath);
  const store = new LibraryStore(database);
  const scanner = dependencies.scanner ?? new LibraryScanner();
  const metadataService = dependencies.metadataService ?? new MetadataService();
  const coverService = new CoverService(
    database,
    dependencies.coverCacheDir ?? join(dirname(databasePath), 'cover-cache'),
  );
  const albumService = new AlbumService();
  const scanJobQueue = new ScanJobQueue(store, scanner, metadataService, coverService, albumService);

  return new LibraryService(store, scanJobQueue, () => database.close());
};

let defaultLibraryService: LibraryService | null = null;

export const getLibraryService = (): LibraryService => {
  if (!defaultLibraryService) {
    const electronApp = (electron as unknown as { app?: { getPath: (name: string) => string } }).app;

    if (!electronApp) {
      throw new Error('Electron app module is unavailable outside the Electron main process');
    }

    defaultLibraryService = createLibraryService(join(electronApp.getPath('userData'), 'echo-library.sqlite'));
  }

  return defaultLibraryService;
};
