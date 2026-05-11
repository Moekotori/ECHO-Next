import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ParsedTrackMetadata } from './libraryTypes';

type CoverCandidate = {
  sourceType: 'embedded' | 'folder' | 'default';
  data: Uint8Array;
  mimeType: string | null;
  originalPath: string | null;
};

const sidecarNames = ['cover', 'folder', 'front'];
const sidecarExtensions = ['.jpg', '.jpeg', '.png', '.webp'];

const extensionToMimeType = (extension: string): string | null => {
  switch (extension.toLocaleLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    case '.svg':
      return 'image/svg+xml';
    default:
      return null;
  }
};

const defaultCoverSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
<rect width="512" height="512" fill="#20242b"/>
<circle cx="256" cy="256" r="132" fill="#2f3944"/>
<circle cx="256" cy="256" r="46" fill="#8fb7ff"/>
<path d="M256 92a164 164 0 1 1 0 328 164 164 0 0 1 0-328zm0 22a142 142 0 1 0 0 284 142 142 0 0 0 0-284z" fill="#f3f6fb" opacity=".18"/>
</svg>`;

export class CoverService {
  constructor(
    private readonly database: DatabaseSync,
    private readonly cacheRoot: string,
  ) {
    mkdirSync(this.cacheRoot, { recursive: true });
  }

  ensureCover(filePath: string, metadata: ParsedTrackMetadata, now = new Date().toISOString()): string | null {
    const candidate = this.resolveCoverCandidate(filePath, metadata);
    const sourceHash = createHash('sha256').update(candidate.data).digest('hex');
    const existing = this.database.prepare('SELECT id FROM covers WHERE source_hash = ?').get(sourceHash);

    if (typeof existing?.id === 'string') {
      return existing.id;
    }

    const id = randomUUID();
    const extension = this.extensionForMimeType(candidate.mimeType, candidate.originalPath);
    const coverDirectory = join(this.cacheRoot, id);
    const thumbPath = join(coverDirectory, `thumb${extension}`);
    const largePath = join(coverDirectory, `large${extension}`);
    const originalPath = join(coverDirectory, `original${extension}`);

    mkdirSync(coverDirectory, { recursive: true });
    writeFileSync(thumbPath, candidate.data);
    writeFileSync(largePath, candidate.data);
    writeFileSync(originalPath, candidate.data);

    this.database
      .prepare(
        `INSERT INTO covers (
          id, source_type, source_hash, mime_type, cover_thumb, cover_large, cover_original, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        candidate.sourceType,
        sourceHash,
        candidate.mimeType,
        thumbPath,
        largePath,
        originalPath,
        now,
        now,
      );

    return id;
  }

  private resolveCoverCandidate(filePath: string, metadata: ParsedTrackMetadata): CoverCandidate {
    if (metadata.embeddedCover) {
      return {
        sourceType: 'embedded',
        data: metadata.embeddedCover.data,
        mimeType: metadata.embeddedCover.mimeType,
        originalPath: null,
      };
    }

    const folderCover = this.findFolderCover(filePath);
    if (folderCover) {
      return folderCover;
    }

    return {
      sourceType: 'default',
      data: new TextEncoder().encode(defaultCoverSvg),
      mimeType: 'image/svg+xml',
      originalPath: null,
    };
  }

  private findFolderCover(filePath: string): CoverCandidate | null {
    const directory = dirname(filePath);

    for (const name of sidecarNames) {
      for (const extension of sidecarExtensions) {
        const coverPath = join(directory, `${name}${extension}`);

        if (!existsSync(coverPath)) {
          continue;
        }

        return {
          sourceType: 'folder',
          data: readFileSync(coverPath),
          mimeType: extensionToMimeType(extension),
          originalPath: coverPath,
        };
      }
    }

    return null;
  }

  private extensionForMimeType(mimeType: string | null, originalPath: string | null): string {
    if (originalPath) {
      const extension = extname(originalPath);
      if (extension) {
        return extension;
      }
    }

    switch (mimeType) {
      case 'image/jpeg':
        return '.jpg';
      case 'image/png':
        return '.png';
      case 'image/webp':
        return '.webp';
      case 'image/svg+xml':
        return '.svg';
      default:
        return '.bin';
    }
  }
}
