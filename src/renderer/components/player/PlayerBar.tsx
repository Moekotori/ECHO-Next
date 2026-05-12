import { useCallback, useEffect, useRef, useState } from 'react';
import { Gauge, Import, Music2 } from 'lucide-react';
import type { AudioStatus } from '../../../shared/types/audio';
import type { PlaybackStatus } from '../../../shared/types/playback';
import { usePlaybackQueue } from '../../stores/PlaybackQueueProvider';
import { PlayerProgress } from './PlayerProgress';
import { PlayerStatusChips } from './PlayerStatusChips';
import { PlayerTransport } from './PlayerTransport';
import { PlayerVolumeControl } from './PlayerVolumeControl';
import { titleFromPath } from './playerFormat';

type PlayerBarProps = {
  onOpenAudioSettings?: () => void;
};

export const PlayerBar = ({ onOpenAudioSettings }: PlayerBarProps): JSX.Element => {
  const queue = usePlaybackQueue();
  const setQueueCurrentTrackId = queue.setCurrentTrackId;
  const [playbackStatus, setPlaybackStatus] = useState<PlaybackStatus | null>(null);
  const [audioStatus, setAudioStatus] = useState<AudioStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seekPreviewSeconds, setSeekPreviewSeconds] = useState<number | null>(null);
  const handledEndedTrackRef = useRef<string | null>(null);
  const refreshRequestRef = useRef(0);

  const refreshStatus = useCallback(async (): Promise<void> => {
    const echo = window.echo;

    if (!echo) {
      setError('Desktop bridge unavailable');
      return;
    }

    try {
      const requestId = refreshRequestRef.current + 1;
      refreshRequestRef.current = requestId;
      const [nextPlaybackStatus, nextAudioStatus] = await Promise.all([
        echo.playback.getStatus(),
        echo.audio.getStatus(),
      ]);

      if (refreshRequestRef.current !== requestId) {
        return;
      }

      setPlaybackStatus(nextPlaybackStatus);
      setAudioStatus(nextAudioStatus);
      const nextTrackId = nextPlaybackStatus.currentTrackId ?? nextAudioStatus.currentTrackId ?? null;
      if (nextTrackId) {
        setQueueCurrentTrackId(nextTrackId);
      }
      setError(nextAudioStatus.error);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
    }
  }, [setQueueCurrentTrackId]);

  useEffect(() => {
    void refreshStatus();
    // TODO: Replace this polling with playback:onStatus / audio:onStatus IPC push events.
    // Position updates must be throttled and must not cause SongsPage or TrackList rerenders.
    const timer = window.setInterval(() => {
      void refreshStatus();
    }, 500);

    return () => window.clearInterval(timer);
  }, [refreshStatus]);

  const state = audioStatus?.state ?? playbackStatus?.state ?? 'idle';
  const isPlaying = state === 'playing';
  const statusTrackId = playbackStatus?.currentTrackId ?? audioStatus?.currentTrackId ?? null;
  const trackId = queue.currentTrackId ?? statusTrackId;
  const currentTrack = queue.currentTrack ?? queue.tracks.find((track) => track.id === trackId) ?? null;
  const filePath = currentTrack?.path ?? audioStatus?.currentFilePath ?? playbackStatus?.filePath ?? null;
  const positionSeconds = audioStatus?.positionSeconds ?? (playbackStatus?.positionMs ?? 0) / 1000;
  const durationSeconds = audioStatus?.durationSeconds ?? (playbackStatus?.durationMs ?? 0) / 1000;
  const displayedPositionSeconds = seekPreviewSeconds ?? positionSeconds;
  const title = currentTrack?.title ?? titleFromPath(filePath);
  const artist = currentTrack?.artist || currentTrack?.albumArtist || (filePath ? 'Local file' : 'Ready');

  const runPlaybackAction = useCallback(
    async (action: () => Promise<PlaybackStatus | null>): Promise<void> => {
      try {
        refreshRequestRef.current += 1;
        const status = await action();
        if (status) {
          setPlaybackStatus(status);
          setQueueCurrentTrackId(status.currentTrackId);
        }
        await refreshStatus();
      } catch (actionError) {
        setError(actionError instanceof Error ? actionError.message : String(actionError));
      }
    },
    [refreshStatus, setQueueCurrentTrackId],
  );

  const handlePlayPause = useCallback(async (): Promise<void> => {
    const playback = window.echo?.playback;

    if (!playback) {
      setError('Desktop bridge unavailable');
      return;
    }

    await runPlaybackAction(() => (isPlaying ? playback.pause() : playback.play()));
  }, [isPlaying, runPlaybackAction]);

  const handlePrevious = useCallback((): void => {
    void runPlaybackAction(queue.playPrevious);
  }, [queue.playPrevious, runPlaybackAction]);

  const handleNext = useCallback((): void => {
    void runPlaybackAction(queue.playNext);
  }, [queue.playNext, runPlaybackAction]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.code !== 'Space' || event.repeat) {
        return;
      }

      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName;
      const isTextInput = tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT';

      if (target?.isContentEditable || isTextInput) {
        return;
      }

      event.preventDefault();
      void handlePlayPause();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handlePlayPause]);

  useEffect(() => {
    if (state !== 'ended' || !trackId || handledEndedTrackRef.current === trackId) {
      return;
    }

    handledEndedTrackRef.current = trackId;
    void runPlaybackAction(queue.playNext);
  }, [queue.playNext, runPlaybackAction, state, trackId]);

  useEffect(() => {
    if (state === 'playing') {
      handledEndedTrackRef.current = null;
    }
  }, [state, trackId]);

  const commitSeek = useCallback(
    async (nextPositionSeconds: number): Promise<void> => {
      const playback = window.echo?.playback;

      if (!playback || durationSeconds <= 0) {
        setSeekPreviewSeconds(null);
        return;
      }

      const safePositionSeconds = Math.min(durationSeconds, Math.max(0, nextPositionSeconds));

      try {
        setSeekPreviewSeconds(safePositionSeconds);
        setPlaybackStatus(await playback.seek(safePositionSeconds));
        await refreshStatus();
      } catch (seekError) {
        setError(seekError instanceof Error ? seekError.message : String(seekError));
      } finally {
        setSeekPreviewSeconds(null);
      }
    },
    [durationSeconds, refreshStatus],
  );

  return (
    <footer className="player-bar" aria-label="播放控制">
      <div className="player-now">
        <div className="player-cover" data-empty={!currentTrack?.coverThumb} aria-hidden="true">
          {currentTrack?.coverThumb ? <img alt="" src={currentTrack.coverThumb} /> : <Music2 size={30} />}
          <div className="cover-sheen" />
        </div>
        <div className="player-track-copy">
          <strong>{title}</strong>
          <span>{artist}</span>
          <PlayerStatusChips status={audioStatus} state={state} track={currentTrack} />
        </div>
      </div>

      <div className="player-center">
        <PlayerTransport
          canGoNext={queue.canGoNext}
          canGoPrevious={queue.canGoPrevious}
          isPlaying={isPlaying}
          isShuffleEnabled={queue.isShuffleEnabled}
          onNext={handleNext}
          onPlayPause={() => void handlePlayPause()}
          onPrevious={handlePrevious}
          onToggleShuffle={queue.toggleShuffle}
        />
        <PlayerProgress
          disabled={!filePath}
          durationSeconds={durationSeconds}
          positionSeconds={displayedPositionSeconds}
          onCommit={(nextPositionSeconds) => void commitSeek(nextPositionSeconds)}
          onPreview={setSeekPreviewSeconds}
        />
        {error ? <span className="player-error">{error}</span> : null}
      </div>

      <div className="output-status">
        <PlayerVolumeControl status={audioStatus} onError={setError} onStatusChange={setAudioStatus} />
        <button className="icon-button" type="button" aria-label="输出设备" title="输出设备">
          <Gauge size={17} />
        </button>
        <button className="icon-button" type="button" aria-label="音频控制" title="音频控制" onClick={onOpenAudioSettings}>
          <Import size={17} />
        </button>
      </div>
    </footer>
  );
};
