export const IpcChannels = {
  AppGetVersion: 'app:get-version',
  LibraryAddFolder: 'library:add-folder',
  LibraryGetFolders: 'library:get-folders',
  LibraryRemoveFolder: 'library:remove-folder',
  LibraryScanFolder: 'library:scan-folder',
  LibraryGetScanStatus: 'library:get-scan-status',
  LibraryCancelScan: 'library:cancel-scan',
  LibraryGetTracks: 'library:get-tracks',
  LibraryGetAlbums: 'library:get-albums',
  LibraryGetAlbumTracks: 'library:get-album-tracks',
  LibraryGetSummary: 'library:get-summary',
  PlaybackGetStatus: 'playback:get-status',
  PlaybackPlayLocalFile: 'playback:play-local-file',
  PlaybackPlay: 'playback:play',
  PlaybackPause: 'playback:pause',
  PlaybackStop: 'playback:stop',
  PlaybackSeek: 'playback:seek',
  AudioGetStatus: 'audio:get-status',
  AudioListDevices: 'audio:list-devices',
  AudioSetOutput: 'audio:set-output',
} as const;

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels];
