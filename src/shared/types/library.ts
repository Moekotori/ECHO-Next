export type LibrarySummary = {
  songCount: number;
  albumCount: number;
  artistCount: number;
  folderCount: number;
  totalDuration: number;
  lastScanAt: string | null;
};

export type LibraryFolder = {
  id: string;
  path: string;
  name: string;
  status: 'active' | 'removed';
  createdAt: string;
  updatedAt: string;
};

export type LibraryScanStatus = {
  id: string;
  folderId: string;
  status: 'queued' | 'running' | 'completed' | 'cancelled' | 'failed';
  phase:
    | 'queued'
    | 'discovering'
    | 'checking_cache'
    | 'reading_metadata'
    | 'extracting_covers'
    | 'grouping_albums'
    | 'writing_database'
    | 'finished'
    | 'failed'
    | 'cancelled';
  totalFiles: number;
  processedFiles: number;
  skippedFiles: number;
  addedTracks: number;
  updatedTracks: number;
  removedTracks: number;
  coverCount?: number;
  errorCount: number;
  errors: string[];
  startedAt: string | null;
  finishedAt: string | null;
};

export type LibrarySort = 'title' | 'artist' | 'album' | 'recent';

export type LibraryPageQuery = {
  page?: number;
  pageSize?: number;
  search?: string;
  sort?: LibrarySort;
};

export type LibraryTrack = {
  id: string;
  path: string;
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
  coverId: string | null;
  coverThumb: string | null;
  metadataStatus?: string;
  fieldSources: Record<string, string>;
};

export type LibraryAlbum = {
  id: string;
  albumKey: string;
  title: string;
  albumArtist: string;
  year: number | null;
  trackCount: number;
  duration: number;
  coverId: string | null;
  coverThumb: string | null;
};

export type LibraryPage<T> = {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
};
