import type {
  LibraryAlbum,
  LibraryFolder,
  LibraryPage,
  LibraryPageQuery,
  LibraryScanStatus,
  LibrarySummary,
  LibraryTrack,
} from '../../shared/types/library';

export type {
  LibraryAlbum,
  LibraryFolder,
  LibraryPage,
  LibraryPageQuery,
  LibraryScanStatus,
  LibrarySummary,
  LibraryTrack,
};

export type ScannedAudioFile = {
  path: string;
  folderId: string;
  sizeBytes: number;
  mtimeMs: number;
};

export type FieldSource =
  | 'manual'
  | 'embedded'
  | 'sidecar'
  | 'folder_structure'
  | 'network'
  | 'technical'
  | 'filename_fallback'
  | 'unknown';

export type FieldSources = Record<string, FieldSource>;

export type ParsedTrackMetadata = {
  title: string;
  artist: string;
  album: string;
  albumArtist: string;
  trackNo: number | null;
  discNo: number | null;
  year: number | null;
  duration: number;
  codec: string | null;
  sampleRate: number | null;
  bitDepth: number | null;
  bitrate: number | null;
  fieldSources: FieldSources;
  embeddedCover?: {
    data: Uint8Array;
    mimeType: string | null;
  };
};

export type TrackWrite = ParsedTrackMetadata &
  ScannedAudioFile & {
    id: string;
    coverId: string | null;
    createdAt?: string;
    updatedAt: string;
  };

export type StoredTrackFingerprint = {
  id: string;
  sizeBytes: number;
  mtimeMs: number;
};

export type ScanJobUpdate = Partial<
  Pick<
    LibraryScanStatus,
    | 'status'
    | 'totalFiles'
    | 'processedFiles'
    | 'skippedFiles'
    | 'addedTracks'
    | 'updatedTracks'
    | 'removedTracks'
    | 'errorCount'
    | 'errors'
    | 'phase'
    | 'startedAt'
    | 'finishedAt'
  >
> & {
  cancelRequested?: boolean;
};

export type ScanResultCounts = {
  processedFiles: number;
  skippedFiles: number;
  addedTracks: number;
  updatedTracks: number;
  removedTracks: number;
  errors: string[];
};
