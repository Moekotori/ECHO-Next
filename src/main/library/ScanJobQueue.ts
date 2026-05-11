import { randomUUID } from 'node:crypto';
import type { AlbumService } from './AlbumService';
import type { CoverService } from './CoverService';
import type { LibraryScanner } from './LibraryScanner';
import type { LibraryStore } from './LibraryStore';
import type { MetadataService } from './MetadataService';
import type { LibraryFolder, LibraryScanStatus, ParsedTrackMetadata, ScannedAudioFile } from './libraryTypes';

type ParsedScanItem = {
  file: ScannedAudioFile;
  metadata: ParsedTrackMetadata;
  existingTrackId: string | null;
};

class ScanCancelledError extends Error {
  constructor() {
    super('scan_cancelled');
  }
}

export class ScanJobQueue {
  private readonly runningJobs = new Map<string, Promise<void>>();
  private readonly metadataConcurrency = 2;

  constructor(
    private readonly store: LibraryStore,
    private readonly scanner: LibraryScanner,
    private readonly metadataService: MetadataService,
    private readonly coverService: CoverService,
    private readonly albumService: AlbumService,
  ) {}

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
    const errors: string[] = [];

    try {
      this.store.updateScanJob(jobId, {
        status: 'running',
        phase: 'discovering_files',
        startedAt,
      });

      const files = await this.scanner.scanFolder(folder.id, folder.path);
      this.store.updateScanJob(jobId, {
        phase: 'checking_cache',
        totalFiles: files.length,
      });

      const changedItems: ParsedScanItem[] = [];
      const changedFiles: Array<{ file: ScannedAudioFile; existingTrackId: string | null }> = [];

      for (const file of files) {
        if (this.store.isScanCancelled(jobId)) {
          throw new ScanCancelledError();
        }

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

      await this.processWithConcurrency(changedFiles, this.metadataConcurrency, async (item) => {
        if (this.store.isScanCancelled(jobId)) {
          throw new ScanCancelledError();
        }

        try {
          const metadata = await this.metadataService.read(item.file);
          changedItems.push({
            ...item,
            metadata,
          });
        } catch (error) {
          errors.push(`${item.file.path}: ${error instanceof Error ? error.message : String(error)}`);
        }

        processedFiles += 1;
        this.store.updateScanJob(jobId, {
          phase: 'reading_metadata',
          processedFiles,
          skippedFiles,
          errors,
        });
      });

      if (this.store.isScanCancelled(jobId)) {
        throw new ScanCancelledError();
      }

      this.store.updateScanJob(jobId, {
        phase: 'extracting_covers',
        processedFiles,
        skippedFiles,
        errors,
      });

      this.store.transaction(() => {
        const timestamp = new Date().toISOString();

        removedTracks = this.store.removeTracksMissingFromFolder(
          folder.id,
          files.map((file) => file.path),
        );

        for (const item of changedItems) {
          let coverId: string | null = null;

          try {
            coverId = this.coverService.ensureCover(item.file.path, item.metadata, timestamp);
          } catch (error) {
            errors.push(`${item.file.path}: cover: ${error instanceof Error ? error.message : String(error)}`);
          }

          const result = this.store.upsertTrack({
            ...item.file,
            ...item.metadata,
            id: item.existingTrackId ?? randomUUID(),
            coverId,
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
          errors,
        });
        this.store.updateScanJob(jobId, {
          status: 'completed',
          phase: 'finished',
          processedFiles,
          skippedFiles,
          addedTracks,
          updatedTracks,
          removedTracks,
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
        errors,
        finishedAt: new Date().toISOString(),
      });
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
