import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { PropsWithChildren } from 'react';
import type { LibraryTrack } from '../../shared/types/library';
import type { PlaybackStatus } from '../../shared/types/playback';

type PlaybackQueueContextValue = {
  tracks: LibraryTrack[];
  currentTrack: LibraryTrack | null;
  currentTrackId: string | null;
  isShuffleEnabled: boolean;
  canGoPrevious: boolean;
  canGoNext: boolean;
  setQueue: (tracks: LibraryTrack[]) => void;
  setCurrentTrackId: (trackId: string | null) => void;
  toggleShuffle: () => void;
  playTrack: (track: LibraryTrack) => Promise<PlaybackStatus>;
  playPrevious: () => Promise<PlaybackStatus | null>;
  playNext: () => Promise<PlaybackStatus | null>;
};

const PlaybackQueueContext = createContext<PlaybackQueueContextValue | null>(null);

const createProbeFromTrack = (track: LibraryTrack) => ({
  durationSeconds: track.duration,
  fileSampleRate: track.sampleRate,
  channels: 2,
  codec: track.codec,
  bitDepth: track.bitDepth,
  bitrate: track.bitrate,
});

const pickRandomTrack = (tracks: LibraryTrack[], currentTrackId: string | null): LibraryTrack | null => {
  const candidates = currentTrackId ? tracks.filter((track) => track.id !== currentTrackId) : tracks;

  if (candidates.length === 0) {
    return tracks[0] ?? null;
  }

  return candidates[Math.floor(Math.random() * candidates.length)] ?? null;
};

export const PlaybackQueueProvider = ({ children }: PropsWithChildren): JSX.Element => {
  const [tracks, setTracks] = useState<LibraryTrack[]>([]);
  const [currentTrackId, setCurrentTrackId] = useState<string | null>(null);
  const [lastPlayedTrack, setLastPlayedTrack] = useState<LibraryTrack | null>(null);
  const [isShuffleEnabled, setIsShuffleEnabled] = useState(false);

  const currentIndex = useMemo(
    () => (currentTrackId ? tracks.findIndex((track) => track.id === currentTrackId) : -1),
    [currentTrackId, tracks],
  );
  const currentTrack = useMemo(() => {
    const queuedTrack = currentTrackId ? tracks.find((track) => track.id === currentTrackId) : null;

    return queuedTrack ?? (lastPlayedTrack?.id === currentTrackId ? lastPlayedTrack : null);
  }, [currentTrackId, lastPlayedTrack, tracks]);

  const setQueue = useCallback((nextTracks: LibraryTrack[]): void => {
    // Phase 1.2 queue scope: this is the visible/loaded SongsPage window, not the full-library playback queue.
    // A later LibraryService-backed queue service should own the real queue.
    setTracks(nextTracks);
  }, []);

  const playTrack = useCallback(async (track: LibraryTrack): Promise<PlaybackStatus> => {
    const playback = window.echo?.playback;

    if (!playback) {
      throw new Error('Desktop bridge unavailable. Open ECHO Next in Electron to play local files.');
    }

    const status = await playback.playLocalFile({
      filePath: track.path,
      trackId: track.id,
      probe: createProbeFromTrack(track),
    });
    setLastPlayedTrack(track);
    setCurrentTrackId(status.currentTrackId ?? track.id);
    return status;
  }, []);

  const playPrevious = useCallback(async (): Promise<PlaybackStatus | null> => {
    if (tracks.length === 0) {
      return null;
    }

    const target = currentIndex > 0 ? tracks[currentIndex - 1] : tracks[tracks.length - 1];
    return target ? playTrack(target) : null;
  }, [currentIndex, playTrack, tracks]);

  const playNext = useCallback(async (): Promise<PlaybackStatus | null> => {
    if (tracks.length === 0) {
      return null;
    }

    const target = isShuffleEnabled
      ? pickRandomTrack(tracks, currentTrackId)
      : currentIndex >= 0
        ? tracks[(currentIndex + 1) % tracks.length]
        : tracks[0];
    return target ? playTrack(target) : null;
  }, [currentIndex, currentTrackId, isShuffleEnabled, playTrack, tracks]);

  const value = useMemo<PlaybackQueueContextValue>(
    () => ({
      tracks,
      currentTrack,
      currentTrackId,
      isShuffleEnabled,
      canGoPrevious: tracks.length > 0,
      canGoNext: tracks.length > 0,
      setQueue,
      setCurrentTrackId,
      toggleShuffle: () => setIsShuffleEnabled((enabled) => !enabled),
      playTrack,
      playPrevious,
      playNext,
    }),
    [currentTrack, currentTrackId, isShuffleEnabled, playNext, playPrevious, playTrack, setQueue, tracks],
  );

  return <PlaybackQueueContext.Provider value={value}>{children}</PlaybackQueueContext.Provider>;
};

export const usePlaybackQueue = (): PlaybackQueueContextValue => {
  const context = useContext(PlaybackQueueContext);

  if (!context) {
    throw new Error('usePlaybackQueue must be used inside PlaybackQueueProvider');
  }

  return context;
};
