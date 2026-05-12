import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import type { CoverExtractOptions, CoverResult, EmbeddedCoverData, MetadataResult, ParsedTrackMetadata } from '../libraryTypes';
import type { CoverExtractor } from './CoverExtractor';

type CoverCandidate = {
  source: CoverResult['source'];
  data: Uint8Array;
  mimeType: string | null;
  originalPath: string | null;
  warnings: string[];
  errors: string[];
};

const sidecarNames = ['cover', 'folder', 'front'];
const sidecarExtensions = ['.jpg', '.jpeg', '.png', '.webp'];

const defaultCoverSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
<rect width="512" height="512" fill="#20242b"/>
<circle cx="256" cy="256" r="132" fill="#2f3944"/>
<circle cx="256" cy="256" r="46" fill="#8fb7ff"/>
<path d="M256 92a164 164 0 1 1 0 328 164 164 0 0 1 0-328zm0 22a142 142 0 1 0 0 284 142 142 0 0 0 0-284z" fill="#f3f6fb" opacity=".18"/>
</svg>`;

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

const embeddedCoverFromMetadata = (metadata: MetadataResult | ParsedTrackMetadata | undefined): EmbeddedCoverData | undefined => {
  if (!metadata) {
    return undefined;
  }

  return 'embeddedCover' in metadata ? metadata.embeddedCover : undefined;
};

export class TsCoverExtractor implements CoverExtractor {
  async extract(filePath: string, options: CoverExtractOptions): Promise<CoverResult> {
    mkdirSync(options.cacheRoot, { recursive: true });

    const candidate = this.resolveCoverCandidate(filePath, options.metadata);
    const sourceHash = createHash('sha256').update(candidate.data).digest('hex');
    const extension = this.extensionForMimeType(candidate.mimeType, candidate.originalPath);
    const coverDirectory = join(options.cacheRoot, sourceHash.slice(0, 2), sourceHash);
    const thumbPath = join(coverDirectory, `thumb${extension}`);
    const largePath = join(coverDirectory, `large${extension}`);
    const originalRef = join(coverDirectory, `original${extension}`);

    mkdirSync(coverDirectory, { recursive: true });
    this.writeIfMissing(thumbPath, candidate.data);
    this.writeIfMissing(largePath, candidate.data);
    this.writeIfMissing(originalRef, candidate.data);

    return {
      source: candidate.source,
      thumbPath,
      largePath,
      originalRef,
      sourceHash,
      mimeType: candidate.mimeType,
      warnings: candidate.warnings,
      errors: candidate.errors,
    };
  }

  private resolveCoverCandidate(filePath: string, metadata: MetadataResult | ParsedTrackMetadata | undefined): CoverCandidate {
    const embeddedCover = embeddedCoverFromMetadata(metadata);

    if (embeddedCover) {
      return {
        source: 'embedded',
        data: embeddedCover.data,
        mimeType: embeddedCover.mimeType,
        originalPath: null,
        warnings: [],
        errors: [],
      };
    }

    const folderCover = this.findFolderCover(filePath);
    if (folderCover) {
      return folderCover;
    }

    return {
      source: 'default',
      data: new TextEncoder().encode(defaultCoverSvg),
      mimeType: 'image/svg+xml',
      originalPath: null,
      warnings: [],
      errors: [],
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

        try {
          return {
            source: 'folder',
            data: readFileSync(coverPath),
            mimeType: extensionToMimeType(extension),
            originalPath: coverPath,
            warnings: [],
            errors: [],
          };
        } catch (error) {
          return {
            source: 'default',
            data: new TextEncoder().encode(defaultCoverSvg),
            mimeType: 'image/svg+xml',
            originalPath: null,
            warnings: [],
            errors: [`${coverPath}: ${error instanceof Error ? error.message : String(error)}`],
          };
        }
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

  private writeIfMissing(filePath: string, data: Uint8Array): void {
    if (!existsSync(filePath)) {
      writeFileSync(filePath, data);
    }
  }
}
