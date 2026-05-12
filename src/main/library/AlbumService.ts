import { createHash } from 'node:crypto';
import { dirname } from 'node:path';

const normalizeKeyPart = (value: string): string => value.trim().toLocaleLowerCase().replace(/\s+/g, ' ');

export type AlbumMergeStrategy = 'standard' | 'sameTitleAndCover';

export type AlbumKeyInput = {
  albumTitle: string;
  albumArtist: string;
  fallbackArtist: string;
  albumArtistSource?: string;
  year: number | null;
  filePath: string;
  trackId: string;
  coverId?: string | null;
  coverSourceHash?: string | null;
  mergeStrategy?: AlbumMergeStrategy;
};

const reliableAlbumArtistSources = new Set(['embedded', 'manual', 'network', 'sidecar']);

export class AlbumService {
  makeAlbumKey(input: AlbumKeyInput): string {
    const normalizedAlbum = normalizeKeyPart(input.albumTitle);

    if (normalizedAlbum.length === 0 || normalizedAlbum === 'unknown album') {
      return `unknown:${input.trackId}`;
    }

    if (input.mergeStrategy === 'sameTitleAndCover') {
      const coverSourceHash = input.coverSourceHash?.trim();

      if (coverSourceHash) {
        // In loose mode the user's explicit preference is to merge same-title,
        // same-cover albums even when year tags differ or are partly missing.
        return createAlbumKey(`cover:${coverSourceHash}`, normalizedAlbum, '');
      }
    }

    return this.makeStandardAlbumKey(input, normalizedAlbum);
  }

  private makeStandardAlbumKey(input: AlbumKeyInput, normalizedAlbum: string): string {
    const normalizedAlbumArtist = normalizeKeyPart(input.albumArtist || '');
    const hasReliableAlbumArtist =
      reliableAlbumArtistSources.has(input.albumArtistSource ?? '') &&
      normalizedAlbumArtist.length > 0 &&
      normalizedAlbumArtist !== 'unknown artist';
    const artistOrGrouping = hasReliableAlbumArtist ? normalizedAlbumArtist : `folder:${normalizeKeyPart(dirname(input.filePath))}`;
    const yearPart = input.year ? String(input.year) : '';
    return createAlbumKey(artistOrGrouping, normalizedAlbum, yearPart);
  }
}

const createAlbumKey = (grouping: string, normalizedAlbum: string, yearPart: string): string =>
  createHash('sha1')
    .update(`${grouping}\u0000${normalizedAlbum}\u0000${yearPart}`)
    .digest('hex');
