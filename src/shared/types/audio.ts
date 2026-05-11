export type AudioOutputMode = 'shared' | 'exclusive' | 'asio';

export type AudioPlaybackState = 'idle' | 'loading' | 'playing' | 'paused' | 'stopped' | 'ended' | 'error';

export type AudioDeviceInfo = {
  id: string;
  index: number;
  name: string;
  outputMode: Exclude<AudioOutputMode, 'exclusive'>;
  sampleRate: number | null;
  sharedDeviceSampleRate: number | null;
  isDefault: boolean;
};

export type AudioOutputSettings = {
  outputMode?: AudioOutputMode;
  deviceIndex?: number;
  deviceName?: string;
  requestedOutputSampleRate?: number;
  volume?: number;
};

export type AudioStatus = {
  host: 'not-initialized' | 'starting' | 'ready' | 'unavailable' | 'error';
  state: AudioPlaybackState;
  outputDeviceId: string | null;
  outputMode: AudioOutputMode;
  currentFilePath: string | null;
  currentTrackId: string | null;
  durationSeconds: number;
  positionSeconds: number;
  channels: number | null;
  codec: string | null;
  bitDepth: number | null;
  fileSampleRate: number | null;
  decoderOutputSampleRate: number | null;
  requestedOutputSampleRate: number | null;
  actualDeviceSampleRate: number | null;
  sharedDeviceSampleRate: number | null;
  resampling: boolean;
  bitPerfectCandidate: boolean;
  sampleRateMismatch: boolean;
  warnings: string[];
  error: string | null;
};
