import { randomUUID } from 'node:crypto';
import type { EchoDatabase } from '../database/createDatabase';
import type { CoverResult, ParsedTrackMetadata } from './libraryTypes';
import { TsCoverExtractor } from './workers/TsCoverExtractor';

export class CoverService {
  private readonly extractor = new TsCoverExtractor();

  constructor(
    private readonly database: EchoDatabase,
    private readonly cacheRoot: string,
  ) {}

  async ensureCover(filePath: string, metadata: ParsedTrackMetadata, now = new Date().toISOString()): Promise<string | null> {
    const result = await this.extractor.extract(filePath, {
      cacheRoot: this.cacheRoot,
      metadata,
      now,
    });

    return this.upsertCover(result, now);
  }

  private upsertCover(result: CoverResult, now: string): string | null {
    const existing = this.database.prepare<unknown[], { id: string }>('SELECT id FROM covers WHERE source_hash = ?').get(result.sourceHash);

    if (existing?.id) {
      return existing.id;
    }

    const id = randomUUID();
    this.database
      .prepare(
        `INSERT INTO covers (
          id, source_type, source_hash, mime_type,
          thumb_path, large_path, original_ref,
          cover_thumb, cover_large, cover_original,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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
}
