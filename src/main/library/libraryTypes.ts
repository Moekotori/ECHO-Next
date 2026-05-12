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

export type ScannedFile = Omit<ScannedAudioFile, 'folderId'>;

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

export type EmbeddedCoverData = {
  data: Uint8Array;
  mimeType: string | null;
};

export type MetadataFields = {
  title: string;
  artist: string;
  album: string;
  albumArtist: string;
  trackNo: number | null;
  discNo: number | null;
  year: number | null;
  genre: string | null;
  duration: number;
  codec: string | null;
  sampleRate: number | null;
  bitDepth: number | null;
  bitrate: number | null;
};

export type MetadataStatus = 'ok' | 'fallback' | 'error';

export type MetadataResult = {
  fields: MetadataFields;
  fieldSources: FieldSources;
  embeddedCover?: EmbeddedCoverData;
  warnings: string[];
  errors: string[];
  status: MetadataStatus;
  raw?: unknown;
};

export type ParsedTrackMetadata = MetadataFields & {
  fieldSources: FieldSources;
  embeddedCover?: EmbeddedCoverData;
  warnings?: string[];
  errors?: string[];
  metadataStatus?: MetadataStatus;
};

export type TrackWrite = ParsedTrackMetadata &
  ScannedAudioFile & {
    id: string;
    coverId: string | null;
    createdAt?: string;
    updatedAt: string;
  };

export type CoverSource = 'embedded' | 'folder' | 'default';

export type CoverResult = {
  source: CoverSource;
  thumbPath: string;
  largePath: string;
  originalRef: string;
  sourceHash: string;
  mimeType: string | null;
  warnings: string[];
  errors: string[];
};

export type CoverExtractOptions = {
  cacheRoot: string;
  metadata?: MetadataResult | ParsedTrackMetadata;
  now?: string;
};

export type ScanOptions = {
  signal?: AbortSignal;
  audioExtensions?: readonly string[];
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
    | 'coverCount'
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
