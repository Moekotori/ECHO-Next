import { EventEmitter } from 'node:events';
import type { Writable } from 'node:stream';
import { DeviceService } from './DeviceService';
import { DecoderPipeline } from './DecoderPipeline';
import { NativeOutputBridge, isNativeOutputBridgeAvailable } from './NativeOutputBridge';
import { PlaybackClock } from './PlaybackClock';
import type {
  AudioDeviceInfo,
  AudioOutputMode,
  AudioOutputSettings,
  AudioPlaybackState,
  AudioProbeResult,
  AudioSessionPlayRequest,
  AudioStatus,
  DecoderRun,
  NativeBridgeReadyResult,
  NativeOutputStartOptions,
  SampleRatePlan,
} from './audioTypes';

type DecoderPipelineLike = Pick<DecoderPipeline, 'probeLocalFile' | 'decodeLocalFile'>;
type DeviceServiceLike = Pick<DeviceService, 'listDevices'>;
type OutputBridgeLike = {
  writable: Writable | null;
  start: (options: NativeOutputStartOptions) => Promise<NativeBridgeReadyResult>;
  stop: () => void;
  getPositionSeconds: () => number;
  on: (event: 'position' | 'ended' | 'error', listener: (...args: unknown[]) => void) => OutputBridgeLike;
};

export type AudioSessionDependencies = {
  decoder?: DecoderPipelineLike;
  deviceService?: DeviceServiceLike;
  createBridge?: () => OutputBridgeLike;
  logger?: (message: string) => void;
};

const fallbackSampleRate = 44100;

const normalizePositiveInteger = (value: unknown): number | null => {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? Math.round(numberValue) : null;
};

const normalizeOutputMode = (value: unknown): AudioOutputMode => {
  return value === 'exclusive' || value === 'asio' ? value : 'shared';
};

const defaultStatus = (): AudioStatus => ({
  host: isNativeOutputBridgeAvailable() ? 'not-initialized' : 'unavailable',
  state: 'idle',
  outputDeviceId: null,
  outputMode: 'shared',
  currentFilePath: null,
  currentTrackId: null,
  durationSeconds: 0,
  positionSeconds: 0,
  channels: null,
  codec: null,
  bitDepth: null,
  fileSampleRate: null,
  decoderOutputSampleRate: null,
  requestedOutputSampleRate: null,
  actualDeviceSampleRate: null,
  sharedDeviceSampleRate: null,
  resampling: false,
  bitPerfectCandidate: false,
  sampleRateMismatch: false,
  warnings: [],
  error: null,
});

export class AudioSession extends EventEmitter {
  private readonly decoder: DecoderPipelineLike;
  private readonly deviceService: DeviceServiceLike;
  private readonly createBridge: () => OutputBridgeLike;
  private readonly logger: (message: string) => void;
  private readonly clock = new PlaybackClock();
  private outputSettings: Required<Pick<AudioOutputSettings, 'outputMode' | 'volume'>> &
    Omit<AudioOutputSettings, 'outputMode' | 'volume'> = {
    outputMode: 'shared',
    volume: 1,
  };
  private state: AudioPlaybackState = 'idle';
  private hostStatus: AudioStatus['host'] = defaultStatus().host;
  private currentProbe: AudioProbeResult | null = null;
  private currentTrackId: string | null = null;
  private currentFilePath: string | null = null;
  private currentOutputSettings: AudioOutputSettings | null = null;
  private currentPlan: SampleRatePlan | null = null;
  private currentDevice: AudioDeviceInfo | null = null;
  private bridge: OutputBridgeLike | null = null;
  private decoderRun: DecoderRun | null = null;
  private errorMessage: string | null = null;
  private runToken = 0;

  constructor(dependencies: AudioSessionDependencies = {}) {
    super();
    this.decoder = dependencies.decoder ?? new DecoderPipeline();
    this.deviceService = dependencies.deviceService ?? new DeviceService();
    this.createBridge = dependencies.createBridge ?? (() => new NativeOutputBridge());
    this.logger = dependencies.logger ?? (() => undefined);
    this.on('error', () => undefined);
  }

  listDevices(): AudioDeviceInfo[] {
    return this.deviceService.listDevices();
  }

  setOutput(settings: AudioOutputSettings): AudioStatus {
    this.outputSettings = {
      ...this.outputSettings,
      ...settings,
      outputMode: normalizeOutputMode(settings.outputMode ?? this.outputSettings.outputMode),
      volume: Math.max(0, Math.min(1, Number(settings.volume ?? this.outputSettings.volume) || 0)),
    };
    this.currentDevice = this.resolveSelectedDevice(this.outputSettings);
    this.emitStatus();
    return this.getStatus();
  }

  async playLocalFile(request: AudioSessionPlayRequest): Promise<AudioStatus> {
    const token = this.runToken + 1;
    this.runToken = token;
    this.stopResources();

    this.state = 'loading';
    this.hostStatus = 'starting';
    this.errorMessage = null;
    this.currentFilePath = request.filePath;
    this.currentTrackId = request.trackId ?? null;
    this.currentProbe = null;
    this.currentPlan = null;
    this.currentOutputSettings = {
      ...this.outputSettings,
      ...request.output,
      outputMode: normalizeOutputMode(request.output?.outputMode ?? this.outputSettings.outputMode),
    };
    this.currentDevice = this.resolveSelectedDevice(this.currentOutputSettings);
    this.emitStatus();

    try {
      const probe = await this.decoder.probeLocalFile(request.filePath);
      this.assertCurrentRun(token);
      this.currentProbe = probe;
      this.currentPlan = this.createSampleRatePlan(probe, this.currentOutputSettings, this.currentDevice);
      this.clock.reset(request.startSeconds ?? 0, this.currentPlan.requestedOutputSampleRate);

      const bridge = this.createBridge();
      this.bridge = bridge;
      this.attachBridgeEvents(bridge, token);

      const outputMode = this.currentPlan.outputMode;
      const ready = await bridge.start({
        requestedOutputSampleRate: this.currentPlan.requestedOutputSampleRate,
        channels: probe.channels,
        deviceIndex: this.currentOutputSettings.deviceIndex,
        deviceName: this.currentOutputSettings.deviceName,
        asio: outputMode === 'asio',
        exclusive: outputMode === 'exclusive',
        volume: this.currentOutputSettings.volume,
        startSeconds: request.startSeconds ?? 0,
        playbackRate: 1,
      });
      this.assertCurrentRun(token);
      this.applyReadyResult(ready);

      const run = this.decoder.decodeLocalFile({
        filePath: request.filePath,
        startSeconds: request.startSeconds ?? 0,
        channels: probe.channels,
        decoderOutputSampleRate: this.currentPlan.decoderOutputSampleRate,
      });
      this.decoderRun = run;

      const writable = bridge.writable;
      if (!writable) {
        throw new Error('native output bridge did not expose a writable PCM stream');
      }

      run.stream.pipe(writable);
      run.done.catch((error: unknown) => {
        if (this.runToken === token) {
          this.handleError(error instanceof Error ? error : new Error(String(error)));
        }
      });

      this.state = 'playing';
      this.hostStatus = 'ready';
      this.emitStatus();
      return this.getStatus();
    } catch (error) {
      if (this.runToken === token) {
        this.handleError(error instanceof Error ? error : new Error(String(error)));
      }

      throw error;
    }
  }

  play(): AudioStatus {
    if (this.state === 'paused' && this.decoderRun) {
      this.decoderRun.stream.resume();
      this.state = 'playing';
      this.emitStatus();
    }

    return this.getStatus();
  }

  pause(): AudioStatus {
    if (this.state === 'playing' && this.decoderRun) {
      this.updatePositionFromOutput();
      this.decoderRun.stream.pause();
      this.state = 'paused';
      this.emitStatus();
    }

    return this.getStatus();
  }

  stop(): AudioStatus {
    this.runToken += 1;
    this.stopResources();
    this.state = 'stopped';
    this.hostStatus = isNativeOutputBridgeAvailable() ? 'not-initialized' : 'unavailable';
    this.currentProbe = null;
    this.currentTrackId = null;
    this.currentFilePath = null;
    this.currentPlan = null;
    this.currentDevice = null;
    this.errorMessage = null;
    this.clock.reset(0, null);
    this.emitStatus();
    return this.getStatus();
  }

  async seek(positionSeconds: number): Promise<AudioStatus> {
    if (!this.currentFilePath || !this.currentOutputSettings) {
      return this.getStatus();
    }

    return this.playLocalFile({
      filePath: this.currentFilePath,
      trackId: this.currentTrackId ?? undefined,
      startSeconds: Math.max(0, positionSeconds),
      output: this.currentOutputSettings,
    });
  }

  getStatus(): AudioStatus {
    this.updatePositionFromOutput();

    const status = defaultStatus();
    const plan = this.currentPlan;

    return {
      ...status,
      host: this.hostStatus,
      state: this.state,
      outputDeviceId: this.currentDevice?.id ?? null,
      outputMode: plan?.outputMode ?? this.outputSettings.outputMode,
      currentFilePath: this.currentFilePath,
      currentTrackId: this.currentTrackId,
      durationSeconds: this.currentProbe?.durationSeconds ?? 0,
      positionSeconds: this.clock.getPositionSeconds(),
      channels: this.currentProbe?.channels ?? null,
      codec: this.currentProbe?.codec ?? null,
      bitDepth: this.currentProbe?.bitDepth ?? null,
      fileSampleRate: plan?.fileSampleRate ?? null,
      decoderOutputSampleRate: plan?.decoderOutputSampleRate ?? null,
      requestedOutputSampleRate: plan?.requestedOutputSampleRate ?? null,
      actualDeviceSampleRate: plan?.actualDeviceSampleRate ?? null,
      sharedDeviceSampleRate: plan?.sharedDeviceSampleRate ?? this.currentDevice?.sharedDeviceSampleRate ?? null,
      resampling: plan?.resampling ?? false,
      bitPerfectCandidate: plan?.bitPerfectCandidate ?? false,
      sampleRateMismatch: plan?.sampleRateMismatch ?? false,
      warnings: plan?.warnings ?? [],
      error: this.errorMessage,
    };
  }

  private createSampleRatePlan(
    probe: AudioProbeResult,
    outputSettings: AudioOutputSettings,
    selectedDevice: AudioDeviceInfo | null,
    actualDeviceSampleRate: number | null = null,
  ): SampleRatePlan {
    const outputMode = normalizeOutputMode(outputSettings.outputMode);
    const fileSampleRate = probe.fileSampleRate;
    const sourceSampleRate = fileSampleRate ?? fallbackSampleRate;
    const explicitRequestedSampleRate = normalizePositiveInteger(outputSettings.requestedOutputSampleRate);
    const sharedDeviceSampleRate =
      normalizePositiveInteger(selectedDevice?.sharedDeviceSampleRate) ??
      (outputMode === 'shared' ? normalizePositiveInteger(selectedDevice?.sampleRate) : null);
    const requestedOutputSampleRate =
      outputMode === 'shared'
        ? explicitRequestedSampleRate ?? sharedDeviceSampleRate ?? sourceSampleRate
        : explicitRequestedSampleRate ?? sourceSampleRate;
    const decoderOutputSampleRate = requestedOutputSampleRate;
    const warnings: string[] = [];

    if (!fileSampleRate) {
      warnings.push('file_sample_rate_unknown_using_44100_fallback');
    }

    if (outputMode !== 'shared' && explicitRequestedSampleRate && explicitRequestedSampleRate !== sourceSampleRate) {
      warnings.push('explicit_resampling_requested_for_exclusive_output');
    }

    const sampleRateMismatch =
      actualDeviceSampleRate !== null && actualDeviceSampleRate !== requestedOutputSampleRate;
    if (sampleRateMismatch) {
      warnings.push(
        `actual_device_sample_rate_mismatch:${requestedOutputSampleRate}->${actualDeviceSampleRate}`,
      );
    }

    const fileToDecoderResampling = fileSampleRate !== null && fileSampleRate !== decoderOutputSampleRate;
    const outputSideResampling =
      actualDeviceSampleRate !== null && actualDeviceSampleRate !== decoderOutputSampleRate;
    const sharedModeResampling =
      outputMode === 'shared' &&
      fileSampleRate !== null &&
      ((actualDeviceSampleRate !== null && actualDeviceSampleRate !== fileSampleRate) ||
        requestedOutputSampleRate !== fileSampleRate);
    const resampling = fileToDecoderResampling || outputSideResampling || sharedModeResampling;

    if (sharedModeResampling) {
      warnings.push('shared_output_resampling_or_mixer_rate_difference');
    }

    const bitPerfectCandidate =
      outputMode !== 'shared' &&
      fileSampleRate !== null &&
      fileSampleRate === decoderOutputSampleRate &&
      fileSampleRate === requestedOutputSampleRate &&
      (actualDeviceSampleRate === null || actualDeviceSampleRate === requestedOutputSampleRate) &&
      !sampleRateMismatch;

    return {
      fileSampleRate,
      decoderOutputSampleRate,
      requestedOutputSampleRate,
      actualDeviceSampleRate,
      sharedDeviceSampleRate,
      outputMode,
      resampling,
      bitPerfectCandidate,
      sampleRateMismatch,
      warnings,
    };
  }

  private applyReadyResult(ready: NativeBridgeReadyResult): void {
    if (!this.currentProbe || !this.currentOutputSettings) {
      return;
    }

    const readyDevice = ready.device;
    const readySharedRate =
      normalizePositiveInteger(readyDevice.sharedDeviceSampleRate) ??
      normalizePositiveInteger(readyDevice.sharedSampleRate);
    const selectedDevice = readySharedRate
      ? {
          ...(this.currentDevice ?? {
            id: `${this.currentOutputSettings.outputMode ?? 'shared'}:ready`,
            index: this.currentOutputSettings.deviceIndex ?? -1,
            name: this.currentOutputSettings.deviceName ?? 'Selected output',
            outputMode: this.currentOutputSettings.outputMode === 'asio' ? 'asio' : 'shared',
            sampleRate: null,
            isDefault: false,
          }),
          sharedDeviceSampleRate: readySharedRate,
        }
      : this.currentDevice;

    this.currentDevice = selectedDevice;
    this.currentPlan = this.createSampleRatePlan(
      this.currentProbe,
      this.currentOutputSettings,
      selectedDevice,
      ready.actualDeviceSampleRate,
    );
    this.clock.setSampleRate(ready.actualDeviceSampleRate ?? this.currentPlan.requestedOutputSampleRate);
  }

  private resolveSelectedDevice(outputSettings: AudioOutputSettings): AudioDeviceInfo | null {
    const deviceIndex = Number(outputSettings.deviceIndex);
    const deviceName = outputSettings.deviceName;

    if (!Number.isInteger(deviceIndex) && !deviceName) {
      return null;
    }

    const outputMode = normalizeOutputMode(outputSettings.outputMode);
    const expectedDeviceMode = outputMode === 'asio' ? 'asio' : 'shared';

    return (
      this.deviceService
        .listDevices()
        .find((device) => {
          if (device.outputMode !== expectedDeviceMode) {
            return false;
          }

          if (Number.isInteger(deviceIndex) && device.index === deviceIndex) {
            return true;
          }

          return Boolean(deviceName && device.name === deviceName);
        }) ?? null
    );
  }

  private attachBridgeEvents(bridge: OutputBridgeLike, token: number): void {
    bridge.on('position', (frames: unknown) => {
      if (this.runToken !== token) {
        return;
      }

      this.clock.updateFrames(Number(frames));
    });
    bridge.on('ended', () => {
      if (this.runToken !== token) {
        return;
      }

      this.state = 'ended';
      this.updatePositionFromOutput();
      this.emit('ended', this.getStatus());
      this.emitStatus();
    });
    bridge.on('error', (error: unknown) => {
      if (this.runToken !== token) {
        return;
      }

      this.handleError(error instanceof Error ? error : new Error(String(error)));
    });
  }

  private updatePositionFromOutput(): void {
    if (this.bridge?.getPositionSeconds) {
      const positionSeconds = this.bridge.getPositionSeconds();
      const plan = this.currentPlan;
      const sampleRate = plan?.actualDeviceSampleRate ?? plan?.requestedOutputSampleRate ?? null;
      this.clock.reset(positionSeconds, sampleRate);
    }
  }

  private stopResources(): void {
    if (this.decoderRun) {
      try {
        this.decoderRun.stream.unpipe();
      } catch {
        // Best-effort resource cleanup.
      }
      this.decoderRun.stop();
      this.decoderRun = null;
    }

    if (this.bridge) {
      this.bridge.stop();
      this.bridge = null;
    }
  }

  private handleError(error: Error): void {
    this.logger(`[AudioSession] ${error.message}`);
    this.errorMessage = error.message;
    this.state = 'error';
    this.hostStatus = 'error';
    this.emit('error', error, this.getStatus());
    this.emitStatus();
  }

  private assertCurrentRun(token: number): void {
    if (this.runToken !== token) {
      throw new Error('audio_session_run_cancelled');
    }
  }

  private emitStatus(): void {
    this.emit('status', this.getStatus());
  }
}

let defaultAudioSession: AudioSession | null = null;

export const getAudioSession = (): AudioSession => {
  defaultAudioSession ??= new AudioSession();
  return defaultAudioSession;
};
