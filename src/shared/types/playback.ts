import type { AudioOutputSettings, AudioPlaybackState } from './audio';

export type PlaybackStatus = {
  state: AudioPlaybackState;
  currentTrackId: string | null;
  positionMs: number;
  durationMs: number;
  filePath: string | null;
};

export type PlaybackStartRequest = {
  filePath: string;
  trackId?: string;
  startSeconds?: number;
  output?: AudioOutputSettings;
};
