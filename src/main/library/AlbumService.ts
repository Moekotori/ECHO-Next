import { createHash } from 'node:crypto';
import { dirname } from 'node:path';

const normalizeKeyPart = (value: string): string => value.trim().toLocaleLowerCase().replace(/\s+/g, ' ');

export type AlbumKeyInput = {
  albumTitle: string;
  albumArtist: string;
  fallbackArtist: string;
  year: number | null;
  filePath: string;
  trackId: string;
};

export class AlbumService {
  makeAlbumKey(input: AlbumKeyInput): string {
    const normalizedAlbum = normalizeKeyPart(input.albumTitle);

    if (normalizedAlbum.length === 0 || normalizedAlbum === 'unknown album') {
      return `unknown:${input.trackId}`;
    }

    const normalizedArtist = normalizeKeyPart(input.albumArtist || input.fallbackArtist || '');
    const artistOrFolder = normalizedArtist.length > 0 && normalizedArtist !== 'unknown artist'
      ? normalizedArtist
      : `folder:${normalizeKeyPart(dirname(input.filePath))}`;
    const yearPart = input.year ? String(input.year) : '';
    const digest = createHash('sha1')
      .update(`${artistOrFolder}\u0000${normalizedAlbum}\u0000${yearPart}`)
      .digest('hex');
    return digest;
  }
}
