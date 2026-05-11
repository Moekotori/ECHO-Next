import { ipcMain } from 'electron';
import { IpcChannels } from '../../shared/constants/ipcChannels';
import type { AudioOutputMode, AudioOutputSettings } from '../../shared/types/audio';
import type { PlaybackStartRequest, PlaybackStatus } from '../../shared/types/playback';
import { getAudioSession } from '../audio/AudioSession';

const outputModes = new Set<AudioOutputMode>(['shared', 'exclusive', 'asio']);

const requireText = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }

  return value;
};

const optionalPositiveNumber = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  return value;
};

const optionalNonNegativeNumber = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }

  return value;
};

const normalizeOutputSettings = (value: unknown): AudioOutputSettings | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const input = value as Record<string, unknown>;
  const output: AudioOutputSettings = {};

  if (typeof input.outputMode === 'string' && outputModes.has(input.outputMode as AudioOutputMode)) {
    output.outputMode = input.outputMode as AudioOutputMode;
  }

  if (typeof input.deviceIndex === 'number' && Number.isInteger(input.deviceIndex)) {
    output.deviceIndex = input.deviceIndex;
  }

  if (typeof input.deviceName === 'string' && input.deviceName.trim()) {
    output.deviceName = input.deviceName;
  }

  const requestedOutputSampleRate = optionalPositiveNumber(input.requestedOutputSampleRate);
  if (requestedOutputSampleRate) {
    output.requestedOutputSampleRate = Math.round(requestedOutputSampleRate);
  }

  if (typeof input.volume === 'number' && Number.isFinite(input.volume)) {
    output.volume = Math.max(0, Math.min(1, input.volume));
  }

  return output;
};

const normalizePlayRequest = (value: unknown): PlaybackStartRequest => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('playback request must be an object');
  }

  const input = value as Record<string, unknown>;

  return {
    filePath: requireText(input.filePath, 'filePath'),
    trackId: typeof input.trackId === 'string' && input.trackId.trim() ? input.trackId : undefined,
    startSeconds: optionalNonNegativeNumber(input.startSeconds),
    output: normalizeOutputSettings(input.output),
  };
};

const toPlaybackStatus = (): PlaybackStatus => {
  const status = getAudioSession().getStatus();

  return {
    state: status.state,
    currentTrackId: status.currentTrackId,
    positionMs: Math.round(status.positionSeconds * 1000),
    durationMs: Math.round(status.durationSeconds * 1000),
    filePath: status.currentFilePath,
  };
};

export const registerPlaybackIpc = (): void => {
  ipcMain.handle(IpcChannels.PlaybackGetStatus, (): PlaybackStatus => toPlaybackStatus());
  ipcMain.handle(IpcChannels.PlaybackPlayLocalFile, async (_event, request: unknown): Promise<PlaybackStatus> => {
    await getAudioSession().playLocalFile(normalizePlayRequest(request));
    return toPlaybackStatus();
  });
  ipcMain.handle(IpcChannels.PlaybackPlay, (): PlaybackStatus => {
    getAudioSession().play();
    return toPlaybackStatus();
  });
  ipcMain.handle(IpcChannels.PlaybackPause, (): PlaybackStatus => {
    getAudioSession().pause();
    return toPlaybackStatus();
  });
  ipcMain.handle(IpcChannels.PlaybackStop, (): PlaybackStatus => {
    getAudioSession().stop();
    return toPlaybackStatus();
  });
  ipcMain.handle(IpcChannels.PlaybackSeek, async (_event, positionSeconds: unknown): Promise<PlaybackStatus> => {
    await getAudioSession().seek(optionalNonNegativeNumber(positionSeconds) ?? 0);
    return toPlaybackStatus();
  });
};
