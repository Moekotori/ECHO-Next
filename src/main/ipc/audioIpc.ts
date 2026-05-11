import { ipcMain } from 'electron';
import { IpcChannels } from '../../shared/constants/ipcChannels';
import type { AudioOutputMode, AudioOutputSettings, AudioStatus } from '../../shared/types/audio';
import { getAudioSession } from '../audio/AudioSession';

const outputModes = new Set<AudioOutputMode>(['shared', 'exclusive', 'asio']);

const normalizeOutputSettings = (value: unknown): AudioOutputSettings => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('audio output settings must be an object');
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

  if (
    typeof input.requestedOutputSampleRate === 'number' &&
    Number.isFinite(input.requestedOutputSampleRate) &&
    input.requestedOutputSampleRate > 0
  ) {
    output.requestedOutputSampleRate = Math.round(input.requestedOutputSampleRate);
  }

  if (typeof input.volume === 'number' && Number.isFinite(input.volume)) {
    output.volume = Math.max(0, Math.min(1, input.volume));
  }

  return output;
};

export const registerAudioIpc = (): void => {
  ipcMain.handle(IpcChannels.AudioGetStatus, (): AudioStatus => getAudioSession().getStatus());
  ipcMain.handle(IpcChannels.AudioListDevices, () => getAudioSession().listDevices());
  ipcMain.handle(IpcChannels.AudioSetOutput, (_event, settings: unknown): AudioStatus =>
    getAudioSession().setOutput(normalizeOutputSettings(settings)),
  );
};
