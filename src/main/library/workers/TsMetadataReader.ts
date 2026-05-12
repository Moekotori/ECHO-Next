import { basename, dirname, extname } from 'node:path';
import { parseFile } from 'music-metadata';
import type { IAudioMetadata } from 'music-metadata';
import type { FieldSource, FieldSources, MetadataFields, MetadataResult } from '../libraryTypes';
import type { MetadataReader } from './MetadataReader';

const unknownArtist = 'Unknown Artist';
const unknownAlbum = '';

const cleanText = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const cleanTextList = (value: unknown): string | null => {
  if (Array.isArray(value)) {
    return cleanText(value.find((item) => cleanText(item)));
  }

  return cleanText(value);
};

const guessFromFilename = (filePath: string): { artist: string | null; title: string } => {
  const name = basename(filePath, extname(filePath)).trim();
  const parts = name.split(' - ').map((part) => part.trim()).filter(Boolean);

  if (parts.length >= 2) {
    return {
      artist: parts[0],
      title: parts.slice(1).join(' - '),
    };
  }

  return {
    artist: null,
    title: name || 'Untitled',
  };
};

const folderAlbumFallback = (filePath: string): string | null => {
  const folderName = basename(dirname(filePath)).trim();
  return folderName.length > 0 ? folderName : null;
};

const codecFallback = (filePath: string, embeddedCodec: string | undefined): string | null => {
  const codec = cleanText(embeddedCodec);
  if (codec) {
    return codec;
  }

  const extension = extname(filePath).replace('.', '').toUpperCase();
  return extension.length > 0 ? extension : null;
};

const numberOrNull = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
};

const yearFromMetadata = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }

  if (typeof value === 'string') {
    const match = value.match(/\b(19|20)\d{2}\b/);
    return match ? Number(match[0]) : null;
  }

  return null;
};

const fallbackFields = (filePath: string): MetadataResult => {
  const filenameGuess = guessFromFilename(filePath);
  const folderAlbum = folderAlbumFallback(filePath);
  const artist = filenameGuess.artist ?? unknownArtist;
  const album = folderAlbum ?? unknownAlbum;
  const codec = codecFallback(filePath, undefined);

  return {
    fields: {
      title: filenameGuess.title,
      artist,
      album,
      albumArtist: artist,
      trackNo: null,
      discNo: null,
      year: null,
      genre: null,
      duration: 0,
      codec,
      sampleRate: null,
      bitDepth: null,
      bitrate: null,
    },
    fieldSources: {
      title: 'filename_fallback',
      artist: filenameGuess.artist ? 'filename_fallback' : 'unknown',
      album: folderAlbum ? 'folder_structure' : 'unknown',
      albumArtist: filenameGuess.artist ? 'filename_fallback' : 'unknown',
      trackNo: 'unknown',
      discNo: 'unknown',
      year: 'unknown',
      genre: 'unknown',
      duration: 'unknown',
      codec: codec ? 'filename_fallback' : 'unknown',
      sampleRate: 'unknown',
      bitDepth: 'unknown',
      bitrate: 'unknown',
    },
    warnings: [],
    errors: [],
    status: 'fallback',
  };
};

export class TsMetadataReader implements MetadataReader {
  async read(filePath: string): Promise<MetadataResult> {
    try {
      const metadata = await parseFile(filePath, {
        duration: true,
        skipCovers: false,
      });

      return this.normalize(filePath, metadata);
    } catch (error) {
      const result = fallbackFields(filePath);
      return {
        ...result,
        status: 'error',
        errors: [error instanceof Error ? error.message : String(error)],
      };
    }
  }

  normalize(filePath: string, metadata: IAudioMetadata): MetadataResult {
    const common = metadata.common;
    const format = metadata.format;
    const filenameGuess = guessFromFilename(filePath);
    const fieldSources: FieldSources = {};

    // Fixed priority: manual > embedded > sidecar/info > folder inference > network completion > filename fallback.
    // Phase v0.1 implements embedded tags, folder album fallback, and filename fallback; source names stay stable
    // so a future Rust/C++ reader can return the same shape without changing SQLite, IPC, or renderer code.
    const pickText = (field: string, embeddedValue: string | null, fallbackValue: string, fallbackSource: FieldSource) => {
      if (embeddedValue) {
        fieldSources[field] = 'embedded';
        return embeddedValue;
      }

      fieldSources[field] = fallbackSource;
      return fallbackValue;
    };

    const pickNumber = (field: string, value: number | null): number | null => {
      fieldSources[field] = value !== null ? 'embedded' : 'unknown';
      return value;
    };

    const embeddedTitle = cleanText(common.title);
    const embeddedArtist = cleanTextList(common.artist ?? common.artists?.[0]);
    const embeddedAlbum = cleanText(common.album);
    const embeddedAlbumArtist = cleanTextList(common.albumartist);
    const embeddedGenre = cleanTextList(common.genre);
    const folderAlbum = folderAlbumFallback(filePath);

    const title = pickText('title', embeddedTitle, filenameGuess.title, 'filename_fallback');
    const artist = pickText('artist', embeddedArtist, filenameGuess.artist ?? unknownArtist, filenameGuess.artist ? 'filename_fallback' : 'unknown');
    const album = pickText('album', embeddedAlbum, folderAlbum ?? unknownAlbum, folderAlbum ? 'folder_structure' : 'unknown');
    const albumArtist = pickText('albumArtist', embeddedAlbumArtist, artist, fieldSources.artist);
    const trackNo = pickNumber('trackNo', numberOrNull(common.track?.no));
    const discNo = pickNumber('discNo', numberOrNull(common.disk?.no));
    const year = pickNumber('year', yearFromMetadata(common.year ?? common.date));
    const genre = embeddedGenre;
    fieldSources.genre = genre ? 'embedded' : 'unknown';
    const duration = Math.max(0, Number(format.duration ?? 0));
    fieldSources.duration = duration > 0 ? 'technical' : 'unknown';
    const codec = codecFallback(filePath, format.codec);
    fieldSources.codec = codec ? (format.codec ? 'technical' : 'filename_fallback') : 'unknown';
    const sampleRate = typeof format.sampleRate === 'number' ? format.sampleRate : null;
    fieldSources.sampleRate = sampleRate ? 'technical' : 'unknown';
    const bitDepth = typeof format.bitsPerSample === 'number' ? format.bitsPerSample : null;
    fieldSources.bitDepth = bitDepth ? 'technical' : 'unknown';
    const bitrate = typeof format.bitrate === 'number' ? Math.round(format.bitrate) : null;
    fieldSources.bitrate = bitrate ? 'technical' : 'unknown';
    const picture = common.picture?.[0];

    const fields: MetadataFields = {
      title,
      artist,
      album,
      albumArtist,
      trackNo,
      discNo,
      year,
      genre,
      duration,
      codec,
      sampleRate,
      bitDepth,
      bitrate,
    };

    return {
      fields,
      fieldSources,
      embeddedCover: picture
        ? {
            data: picture.data,
            mimeType: cleanText(picture.format),
          }
        : undefined,
      warnings: [],
      errors: [],
      status: 'ok',
    };
  }
}
