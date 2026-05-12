import { randomUUID } from 'node:crypto';
import type { AlbumService } from './AlbumService';
import type { LibraryStore } from './LibraryStore';
import type {
  CoverResult,
  LibraryFolder,
  LibraryScanStatus,
  MetadataResult,
  ScannedAudioFile,
  ScannedFile,
} from './libraryTypes';
import type { CoverExtractor } from './workers/CoverExtractor';
import type { FileScanner } from './workers/FileScanner';
import type { MetadataReader } from './workers/MetadataReader';

type ParsedScanItem = {
  file: ScannedAudioFile;
  metadata: MetadataResult;
  cover: CoverResult | null;
  existingTrackId: string | null;
};

type ChangedFile = {
  file: ScannedAudioFile;
  existingTrackId: string | null;
};

type ScanJobQueueOptions = {
  coverCacheDir: string;
  metadataConcurrency?: number;
  coverConcurrency?: number;
};

class ScanCancelledError extends Error {
  constructor() {
    super('scan_cancelled');
  }
}

export class ScanJobQueue {
  private readonly runningJobs = new Map<string, Promise<void>>();
  private readonly metadataConcurrency: number;
  private readonly coverConcurrency: number;
  private readonly coverCacheDir: string;

  constructor(
    private readonly store: LibraryStore,
    private readonly fileScanner: FileScanner,
    private readonly metadataReader: MetadataReader,
    private readonly coverExtractor: CoverExtractor,
    private readonly albumService: AlbumService,
    options: ScanJobQueueOptions,
  ) {
    this.metadataConcurrency = options.metadataConcurrency ?? 2;
    this.coverConcurrency = options.coverConcurrency ?? 2;
    this.coverCacheDir = options.coverCacheDir;
  }

  scanFolder(folder: LibraryFolder): LibraryScanStatus {
    const job = this.store.createScanJob(folder.id);
    const run = this.runJob(job.id, folder).finally(() => {
      this.runningJobs.delete(job.id);
    });

    this.runningJobs.set(job.id, run);

    return job;
  }

  getScanStatus(jobId: string): LibraryScanStatus {
    const job = this.store.getScanJob(jobId);

    if (!job) {
      throw new Error(`Unknown scan job ${jobId}`);
    }

    return job;
  }

  cancelScan(jobId: string): LibraryScanStatus {
    const current = this.getScanStatus(jobId);

    if (current.status === 'completed' || current.status === 'failed' || current.status === 'cancelled') {
      return current;
    }

    return this.store.updateScanJob(jobId, {
      cancelRequested: true,
      status: current.status === 'queued' ? 'cancelled' : current.status,
      phase: current.status === 'queued' ? 'cancelled' : current.phase,
      finishedAt: current.status === 'queued' ? new Date().toISOString() : current.finishedAt,
    });
  }

  async waitForIdle(jobId: string): Promise<void> {
    await this.runningJobs.get(jobId);
  }

  private async runJob(jobId: string, folder: LibraryFolder): Promise<void> {
    const startedAt = new Date().toISOString();
    let processedFiles = 0;
    let skippedFiles = 0;
    let addedTracks = 0;
    let updatedTracks = 0;
    let removedTracks = 0;
    let coverCount = 0;
    const errors: string[] = [];

    try {
      this.store.updateScanJob(jobId, {
        status: 'running',
        phase: 'discovering',
        startedAt,
      });

      const files = await this.discoverFiles(jobId, folder, errors);
      this.store.updateScanJob(jobId, {
        phase: 'checking_cache',
        totalFiles: files.length,
        errors,
      });

      const changedFiles: ChangedFile[] = [];

      for (const file of files) {
        this.throwIfCancelled(jobId);

        const existing = this.store.findTrackFingerprint(file.path);

        if (existing && existing.sizeBytes === file.sizeBytes && existing.mtimeMs === file.mtimeMs) {
          processedFiles += 1;
          skippedFiles += 1;
          this.store.updateScanJob(jobId, {
            processedFiles,
            skippedFiles,
          });
          continue;
        }

        changedFiles.push({
          file,
          existingTrackId: existing?.id ?? null,
        });
      }

      this.store.updateScanJob(jobId, {
        phase: 'reading_metadata',
        processedFiles,
        skippedFiles,
        errors,
      });

      const parsedItems: ParsedScanItem[] = [];

      await this.processWithConcurrency(changedFiles, this.metadataConcurrency, async (item) => {
        this.throwIfCancelled(jobId);

        try {
          const metadata = await this.metadataReader.read(item.file.path);
          this.collectWorkerMessages(errors, item.file.path, 'metadata', metadata.warnings, metadata.errors);
          parsedItems.push({
            ...item,
            metadata,
            cover: null,
          });
        } catch (error) {
          errors.push(`${item.file.path}: metadata: ${error instanceof Error ? error.message : String(error)}`);
        }

        processedFiles += 1;
        this.store.updateScanJob(jobId, {
          phase: 'reading_metadata',
          processedFiles,
          skippedFiles,
          errors,
        });
      });

      this.throwIfCancelled(jobId);

      this.store.updateScanJob(jobId, {
        phase: 'extracting_covers',
        processedFiles,
        skippedFiles,
        errors,
      });

      const coverTimestamp = new Date().toISOString();
      await this.processWithConcurrency(parsedItems, this.coverConcurrency, async (item) => {
        this.throwIfCancelled(jobId);

        try {
          const cover = await this.coverExtractor.extract(item.file.path, {
            cacheRoot: this.coverCacheDir,
            metadata: item.metadata,
            now: coverTimestamp,
          });
          this.collectWorkerMessages(errors, item.file.path, 'cover', cover.warnings, cover.errors);
          item.cover = cover;
          coverCount += 1;
        } catch (error) {
          errors.push(`${item.file.path}: cover: ${error instanceof Error ? error.message : String(error)}`);
        }

        this.store.updateScanJob(jobId, {
          phase: 'extracting_covers',
          processedFiles,
          skippedFiles,
          coverCount,
          errors,
        });
      });

      this.throwIfCancelled(jobId);

      this.store.transaction(() => {
        const timestamp = new Date().toISOString();

        removedTracks = this.store.markTracksMissingFromFolder(
          folder.id,
          files.map((file) => file.path),
          timestamp,
        );

        for (const item of parsedItems) {
          const coverId = item.cover ? this.store.upsertCover(item.cover, timestamp) : null;
          const result = this.store.upsertTrack({
            ...item.file,
            ...item.metadata.fields,
            id: item.existingTrackId ?? randomUUID(),
            coverId,
            fieldSources: item.metadata.fieldSources,
            embeddedCover: item.metadata.embeddedCover,
            metadataStatus: item.metadata.status,
            warnings: item.metadata.warnings,
            errors: item.metadata.errors,
            updatedAt: timestamp,
          });

          if (result === 'added') {
            addedTracks += 1;
          } else {
            updatedTracks += 1;
          }
        }

        this.store.updateScanJob(jobId, {
          phase: 'grouping_albums',
          processedFiles,
          skippedFiles,
          addedTracks,
          updatedTracks,
          removedTracks,
          coverCount,
          errors,
        });
        this.store.refreshAlbums(this.albumService, timestamp);
        this.store.refreshArtists();
        this.store.updateScanJob(jobId, {
          phase: 'writing_database',
          processedFiles,
          skippedFiles,
          addedTracks,
          updatedTracks,
          removedTracks,
          coverCount,
          errors,
        });
        this.store.finishFolderScan(folder.id, timestamp);
        this.store.updateScanJob(jobId, {
          status: 'completed',
          phase: 'finished',
          processedFiles,
          skippedFiles,
          addedTracks,
          updatedTracks,
          removedTracks,
          coverCount,
          errors,
          finishedAt: new Date().toISOString(),
        });
      });
    } catch (error) {
      if (error instanceof ScanCancelledError) {
        this.store.updateScanJob(jobId, {
          status: 'cancelled',
          phase: 'cancelled',
          processedFiles,
          skippedFiles,
          addedTracks,
          updatedTracks,
          removedTracks,
          coverCount,
          errors,
          finishedAt: new Date().toISOString(),
        });
        return;
      }

      errors.push(error instanceof Error ? error.message : String(error));
      this.store.updateScanJob(jobId, {
        status: 'failed',
        phase: 'failed',
        processedFiles,
        skippedFiles,
        addedTracks,
        updatedTracks,
        removedTracks,
        coverCount,
        errors,
        finishedAt: new Date().toISOString(),
      });
    }
  }

  private async discoverFiles(jobId: string, folder: LibraryFolder, errors: string[]): Promise<ScannedAudioFile[]> {
    const files: ScannedAudioFile[] = [];

    try {
      for await (const file of this.fileScanner.scanFolder(folder.path)) {
        this.throwIfCancelled(jobId);
        files.push(this.withFolderId(file, folder.id));

        if (files.length % 100 === 0) {
          this.store.updateScanJob(jobId, {
            phase: 'discovering',
            totalFiles: files.length,
            errors,
          });
        }
      }
    } catch (error) {
      errors.push(`${folder.path}: scanner: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }

    return files;
  }

  private withFolderId(file: ScannedFile, folderId: string): ScannedAudioFile {
    return {
      ...file,
      folderId,
    };
  }

  private throwIfCancelled(jobId: string): void {
    if (this.store.isScanCancelled(jobId)) {
      throw new ScanCancelledError();
    }
  }

  private collectWorkerMessages(
    errors: string[],
    filePath: string,
    workerName: string,
    warnings: string[],
    workerErrors: string[],
  ): void {
    for (const warning of warnings) {
      errors.push(`${filePath}: ${workerName} warning: ${warning}`);
    }

    for (const error of workerErrors) {
      errors.push(`${filePath}: ${workerName}: ${error}`);
    }
  }

  private async processWithConcurrency<T>(
    items: T[],
    concurrency: number,
    worker: (item: T) => Promise<void>,
  ): Promise<void> {
    let nextIndex = 0;
    const workerCount = Math.min(Math.max(1, concurrency), items.length);

    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (nextIndex < items.length) {
          const currentIndex = nextIndex;
          nextIndex += 1;
          await worker(items[currentIndex]);
        }
      }),
    );
  }
}
