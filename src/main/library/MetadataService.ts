import { basename, dirname, extname } from 'node:path';
import { parseFile } from 'music-metadata';
import type { IAudioMetadata } from 'music-metadata';
import type { FieldSource, FieldSources, ParsedTrackMetadata, ScannedAudioFile } from './libraryTypes';

const unknownArtist = 'Unknown Artist';
const unknownAlbum = '';

const cleanText = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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

export class MetadataService {
  async read(file: ScannedAudioFile): Promise<ParsedTrackMetadata> {
    const metadata = await parseFile(file.path, {
      duration: true,
      skipCovers: false,
    });

    return this.normalize(file.path, metadata);
  }

  normalize(filePath: string, metadata: IAudioMetadata): ParsedTrackMetadata {
    const common = metadata.common;
    const format = metadata.format;
    const filenameGuess = guessFromFilename(filePath);
    const fieldSources: FieldSources = {};

    // Fixed metadata priority for every field:
    // user manual > embedded tags > sidecar/info > folder structure > network completion > filename fallback.
    // Phase 1 only implements embedded, folder album fallback, and filename fallback. The source map keeps
    // the higher-priority slots explicit so later phases can add manual/sidecar/network without changing rows.
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
    const embeddedArtist = cleanText(common.artist ?? common.artists?.[0]);
    const embeddedAlbum = cleanText(common.album);
    const embeddedAlbumArtist = cleanText(common.albumartist);
    const folderAlbum = folderAlbumFallback(filePath);

    const title = pickText('title', embeddedTitle, filenameGuess.title, 'filename_fallback');
    const artist = pickText('artist', embeddedArtist, filenameGuess.artist ?? unknownArtist, 'filename_fallback');
    const album = pickText('album', embeddedAlbum, folderAlbum ?? unknownAlbum, folderAlbum ? 'folder_structure' : 'unknown');
    const albumArtist = pickText('albumArtist', embeddedAlbumArtist, artist, fieldSources.artist);
    const trackNo = pickNumber('trackNo', numberOrNull(common.track?.no));
    const discNo = pickNumber('discNo', numberOrNull(common.disk?.no));
    const year = pickNumber('year', yearFromMetadata(common.year ?? common.date));
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

    return {
      title,
      artist,
      album,
      albumArtist,
      trackNo,
      discNo,
      year,
      duration,
      codec,
      sampleRate,
      bitDepth,
      bitrate,
      fieldSources,
      embeddedCover: picture
        ? {
            data: picture.data,
            mimeType: cleanText(picture.format),
          }
        : undefined,
    };
  }
}
