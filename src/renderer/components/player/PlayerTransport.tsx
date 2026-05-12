import {
  Heart,
  ListMusic,
  Mic2,
  Pause,
  Play,
  Repeat1,
  Repeat2,
  Shuffle,
  SkipBack,
  SkipForward,
} from 'lucide-react';
import type { RepeatMode } from '../../stores/PlaybackQueueProvider';

type PlayerTransportProps = {
  isPlaying: boolean;
  isShuffleEnabled: boolean;
  repeatMode: RepeatMode;
  canGoPrevious: boolean;
  canGoNext: boolean;
  onPlayPause: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onToggleShuffle: () => void;
  onCycleRepeatMode: () => void;
  onOpenQueue: () => void;
};

export const PlayerTransport = ({
  isPlaying,
  isShuffleEnabled,
  repeatMode,
  canGoPrevious,
  canGoNext,
  onPlayPause,
  onPrevious,
  onNext,
  onToggleShuffle,
  onCycleRepeatMode,
  onOpenQueue,
}: PlayerTransportProps): JSX.Element => (
  <div className="transport">
    <button className="icon-button" type="button" aria-label="Playback queue" title="Playback queue" onClick={onOpenQueue}>
      <ListMusic size={17} />
    </button>
    <button
      className={`icon-button ${isShuffleEnabled ? 'is-soft-active' : ''}`}
      type="button"
      aria-label="Shuffle"
      aria-pressed={isShuffleEnabled}
      title="Shuffle"
      onClick={onToggleShuffle}
    >
      <Shuffle size={17} />
    </button>
    <button className="icon-button" type="button" aria-label="Previous" title="Previous" disabled={!canGoPrevious} onClick={onPrevious}>
      <SkipBack size={18} />
    </button>
    <button className="play-button" type="button" aria-label={isPlaying ? 'Pause' : 'Play'} title={isPlaying ? 'Pause' : 'Play'} onClick={onPlayPause}>
      {isPlaying ? <Pause size={24} fill="currentColor" /> : <Play size={24} fill="currentColor" />}
    </button>
    <button className="icon-button" type="button" aria-label="Next" title="Next" disabled={!canGoNext} onClick={onNext}>
      <SkipForward size={18} />
    </button>
    <button
      className={`icon-button ${repeatMode !== 'off' ? 'is-soft-active' : ''}`}
      type="button"
      aria-label="Repeat"
      aria-pressed={repeatMode !== 'off'}
      title={repeatMode === 'one' ? 'Repeat one' : repeatMode === 'all' ? 'Repeat queue' : 'Repeat off'}
      onClick={onCycleRepeatMode}
    >
      {repeatMode === 'one' ? <Repeat1 size={17} /> : <Repeat2 size={17} />}
    </button>
    <button className="icon-button" type="button" aria-label="Lyrics" title="Lyrics">
      <Mic2 size={17} />
    </button>
    <button className="icon-button" type="button" aria-label="Like" title="Like">
      <Heart size={17} />
    </button>
  </div>
);
