import type { AudioDeviceInfo, AudioOutputSettings, AudioStatus } from '../shared/types/audio';
import type {
  LibraryAlbum,
  LibraryFolder,
  LibraryPage,
  LibraryPageQuery,
  LibraryScanStatus,
  LibrarySummary,
  LibraryTrack,
} from '../shared/types/library';
import type { PlaybackStartRequest, PlaybackStatus } from '../shared/types/playback';

export type EchoApi = {
  app: {
    getVersion: () => Promise<string>;
  };
  library: {
    addFolder: (path: string) => Promise<LibraryFolder>;
    getFolders: () => Promise<LibraryFolder[]>;
    removeFolder: (folderId: string) => Promise<void>;
    scanFolder: (folderId: string) => Promise<LibraryScanStatus>;
    getScanStatus: (jobId: string) => Promise<LibraryScanStatus>;
    cancelScan: (jobId: string) => Promise<LibraryScanStatus>;
    getTracks: (query?: LibraryPageQuery) => Promise<LibraryPage<LibraryTrack>>;
    getAlbums: (query?: LibraryPageQuery) => Promise<LibraryPage<LibraryAlbum>>;
    getAlbumTracks: (
      albumId: string,
      query?: Pick<LibraryPageQuery, 'page' | 'pageSize'>,
    ) => Promise<LibraryPage<LibraryTrack>>;
    getSummary: () => Promise<LibrarySummary>;
  };
  playback: {
    getStatus: () => Promise<PlaybackStatus>;
    playLocalFile: (request: PlaybackStartRequest) => Promise<PlaybackStatus>;
    play: () => Promise<PlaybackStatus>;
    pause: () => Promise<PlaybackStatus>;
    stop: () => Promise<PlaybackStatus>;
    seek: (positionSeconds: number) => Promise<PlaybackStatus>;
  };
  audio: {
    getStatus: () => Promise<AudioStatus>;
    listDevices: () => Promise<AudioDeviceInfo[]>;
    setOutput: (settings: AudioOutputSettings) => Promise<AudioStatus>;
  };
};

declare global {
  interface Window {
    echo: EchoApi;
  }
}
