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

type BridgeStartResult = {
  bridge: OutputBridgeLike;
  plan: SampleRatePlan;
  ready: NativeBridgeReadyResult;
};

export type AudioSessionDependencies = {
  decoder?: DecoderPipelineLike;
  deviceService?: DeviceServiceLike;
  createBridge?: () => OutputBridgeLike;
  isNativeHostAvailable?: () => boolean;
  logger?: (message: string) => void;
};

const fallbackSampleRate = 44100;

const defaultLogger = (message: string): void => {
  console.warn(message);
};

const normalizePositiveInteger = (value: unknown): number | null => {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? Math.round(numberValue) : null;
};

const normalizeOutputMode = (value: unknown): AudioOutputMode => {
  return value === 'exclusive' || value === 'asio' ? value : 'shared';
};

const hasExplicitDeviceSelection = (settings: AudioOutputSettings): boolean => {
  return Number.isInteger(Number(settings.deviceIndex)) || Boolean(settings.deviceName);
};

const createProbeFromHint = (filePath: string, hint: AudioSessionPlayRequest['probe']): AudioProbeResult | null => {
  if (!hint) {
    return null;
  }

  return {
    filePath,
    durationSeconds: Math.max(0, Number(hint.durationSeconds ?? 0)),
    fileSampleRate: normalizePositiveInteger(hint.fileSampleRate),
    channels: Math.max(1, Math.min(8, normalizePositiveInteger(hint.channels) ?? 2)),
    codec: typeof hint.codec === 'string' && hint.codec.trim() ? hint.codec : null,
    bitDepth: normalizePositiveInteger(hint.bitDepth),
    bitrate: normalizePositiveInteger(hint.bitrate),
  };
};

const createProbeHint = (probe: AudioProbeResult): AudioSessionPlayRequest['probe'] => ({
  durationSeconds: probe.durationSeconds,
  fileSampleRate: probe.fileSampleRate,
  channels: probe.channels,
  codec: probe.codec,
  bitDepth: probe.bitDepth,
  bitrate: probe.bitrate,
});

const createDeviceFromOutputSettings = (settings: AudioOutputSettings): AudioDeviceInfo | null => {
  if (!hasExplicitDeviceSelection(settings)) {
    return null;
  }

  const outputMode = normalizeOutputMode(settings.outputMode);
  const outputModeKey = outputMode === 'asio' ? 'asio' : 'shared';
  const deviceIndex = Number.isInteger(Number(settings.deviceIndex)) ? Number(settings.deviceIndex) : -1;

  return {
    id: deviceIndex >= 0 ? `${outputModeKey}:${deviceIndex}` : `${outputModeKey}:${settings.deviceName ?? 'selected'}`,
    index: deviceIndex,
    name: settings.deviceName ?? 'Selected output',
    outputMode: outputModeKey,
    sampleRate: normalizePositiveInteger(settings.requestedOutputSampleRate),
    sharedDeviceSampleRate: null,
    isDefault: false,
  };
};

const defaultStatus = (nativeHostAvailable: boolean): AudioStatus => ({
  host: nativeHostAvailable ? 'not-initialized' : 'unavailable',
  state: 'idle',
  outputDeviceId: null,
  outputDeviceName: null,
  outputDeviceType: null,
  outputBackend: null,
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
  private readonly isNativeHostAvailable: () => boolean;
  private readonly logger: (message: string) => void;
  private readonly clock = new PlaybackClock();
  private outputSettings: Required<Pick<AudioOutputSettings, 'outputMode' | 'volume'>> &
    Omit<AudioOutputSettings, 'outputMode' | 'volume'> = {
    outputMode: 'shared',
    volume: 1,
  };
  private state: AudioPlaybackState = 'idle';
  private hostStatus: AudioStatus['host'] = isNativeOutputBridgeAvailable() ? 'not-initialized' : 'unavailable';
  private currentProbe: AudioProbeResult | null = null;
  private currentTrackId: string | null = null;
  private currentFilePath: string | null = null;
  private currentOutputSettings: AudioOutputSettings | null = null;
  private currentPlan: SampleRatePlan | null = null;
  private currentDevice: AudioDeviceInfo | null = null;
  private currentOutputBackend: string | null = null;
  private currentOutputDeviceType: string | null = null;
  private currentOutputDeviceName: string | null = null;
  private bridge: OutputBridgeLike | null = null;
  private decoderRun: DecoderRun | null = null;
  private errorMessage: string | null = null;
  private pausedPositionSeconds: number | null = null;
  private runToken = 0;

  constructor(dependencies: AudioSessionDependencies = {}) {
    super();
    this.logger = dependencies.logger ?? defaultLogger;
    this.decoder = dependencies.decoder ?? new DecoderPipeline({ logger: this.logger });
    this.deviceService = dependencies.deviceService ?? new DeviceService();
    this.createBridge = dependencies.createBridge ?? (() => new NativeOutputBridge({ logger: this.logger }));
    this.isNativeHostAvailable = dependencies.isNativeHostAvailable ?? isNativeOutputBridgeAvailable;
    this.hostStatus = this.isNativeHostAvailable() ? 'not-initialized' : 'unavailable';
    this.on('error', () => undefined);
  }

  listDevices(): AudioDeviceInfo[] {
    return this.deviceService.listDevices();
  }

  async setOutput(settings: AudioOutputSettings): Promise<AudioStatus> {
    this.updatePositionFromOutput();
    this.outputSettings = {
      ...this.outputSettings,
      ...settings,
      outputMode: normalizeOutputMode(settings.outputMode ?? this.outputSettings.outputMode),
      volume: Math.max(0, Math.min(1, Number(settings.volume ?? this.outputSettings.volume) || 0)),
    };

    if (this.currentOutputSettings) {
      this.currentOutputSettings = {
        ...this.currentOutputSettings,
        ...this.outputSettings,
      };
    }

    this.currentDevice = createDeviceFromOutputSettings(this.currentOutputSettings ?? this.outputSettings);

    if (this.state === 'paused') {
      this.emitStatus();
      return this.getStatus();
    }

    if (this.state === 'playing' && this.currentFilePath && this.currentProbe && this.currentOutputSettings) {
      const positionSeconds = this.clock.getPositionSeconds();
      return this.playLocalFile({
        filePath: this.currentFilePath,
        trackId: this.currentTrackId ?? undefined,
        startSeconds: positionSeconds,
        output: this.currentOutputSettings,
        probe: createProbeHint(this.currentProbe),
      });
    }

    this.emitStatus();
    return this.getStatus();
  }

  async playLocalFile(request: AudioSessionPlayRequest): Promise<AudioStatus> {
    const token = this.runToken + 1;
    this.runToken = token;
    this.stopResources();
    this.logger(
      `[AudioSession] playLocalFile: file="${request.filePath}" trackId=${request.trackId ?? 'n/a'} start=${
        request.startSeconds ?? 0
      }`,
    );

    this.state = 'loading';
    this.hostStatus = 'starting';
    this.errorMessage = null;
    this.currentFilePath = request.filePath;
    this.currentTrackId = request.trackId ?? null;
    this.pausedPositionSeconds = null;
    this.currentProbe = null;
    this.currentPlan = null;
    this.currentOutputBackend = null;
    this.currentOutputDeviceType = null;
    this.currentOutputDeviceName = null;
    this.currentOutputSettings = {
      ...this.outputSettings,
      ...request.output,
      outputMode: normalizeOutputMode(request.output?.outputMode ?? this.outputSettings.outputMode),
    };
    this.currentDevice = createDeviceFromOutputSettings(this.currentOutputSettings);
    this.logger(
      `[AudioSession] output: mode=${this.currentOutputSettings.outputMode ?? 'shared'} device=${
        this.currentDevice ? `${this.currentDevice.index}:${this.currentDevice.name}` : 'default'
      }`,
    );
    this.emitStatus();

    try {
      const probe = createProbeFromHint(request.filePath, request.probe) ?? await this.decoder.probeLocalFile(request.filePath);
      this.assertCurrentRun(token);
      this.currentProbe = probe;
      const { bridge, plan, ready } = await this.startOutputBridgeForProbe(probe, token, request.startSeconds ?? 0);
      this.assertCurrentRun(token);
      this.applyReadyResult(ready);
      this.assertReadySampleRateConsistent();
      this.logger(
        `[AudioSession] host ready: requested=${ready.requestedOutputSampleRate} actual=${
          ready.actualDeviceSampleRate ?? 'n/a'
        }`,
      );
      const activePlan = this.currentPlan ?? plan;
      const run = this.decoder.decodeLocalFile({
        filePath: request.filePath,
        startSeconds: request.startSeconds ?? 0,
        channels: probe.channels,
        decoderOutputSampleRate: activePlan.decoderOutputSampleRate,
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

  async play(): Promise<AudioStatus> {
    if (this.state === 'paused' && this.currentFilePath && this.currentOutputSettings) {
      return this.playLocalFile({
        filePath: this.currentFilePath,
        trackId: this.currentTrackId ?? undefined,
        startSeconds: this.pausedPositionSeconds ?? this.clock.getPositionSeconds(),
        output: this.currentOutputSettings,
      });
    }

    return this.getStatus();
  }

  pause(): AudioStatus {
    if (this.state === 'playing') {
      this.updatePositionFromOutput();
      const positionSeconds = this.clock.getPositionSeconds();
      const sampleRate = this.currentPlan?.actualDeviceSampleRate ?? this.currentPlan?.requestedOutputSampleRate ?? null;
      this.runToken += 1;
      this.stopResources();
      this.pausedPositionSeconds = positionSeconds;
      this.clock.reset(positionSeconds, sampleRate);
      this.state = 'paused';
      this.hostStatus = this.isNativeHostAvailable() ? 'not-initialized' : 'unavailable';
      this.emitStatus();
    }

    return this.getStatus();
  }

  stop(): AudioStatus {
    this.runToken += 1;
    this.stopResources();
    this.state = 'stopped';
    this.hostStatus = this.isNativeHostAvailable() ? 'not-initialized' : 'unavailable';
    this.currentProbe = null;
    this.currentTrackId = null;
    this.currentFilePath = null;
    this.currentPlan = null;
    this.currentDevice = null;
    this.currentOutputBackend = null;
    this.currentOutputDeviceType = null;
    this.currentOutputDeviceName = null;
    this.pausedPositionSeconds = null;
    this.errorMessage = null;
    this.clock.reset(0, null);
    this.emitStatus();
    return this.getStatus();
  }

  async seek(positionSeconds: number): Promise<AudioStatus> {
    if (!this.currentFilePath || !this.currentOutputSettings) {
      return this.getStatus();
    }

    const safePositionSeconds = Math.min(
      Math.max(0, positionSeconds),
      this.currentProbe?.durationSeconds && this.currentProbe.durationSeconds > 0
        ? this.currentProbe.durationSeconds
        : Number.POSITIVE_INFINITY,
    );

    if (this.state === 'paused') {
      const sampleRate = this.currentPlan?.actualDeviceSampleRate ?? this.currentPlan?.requestedOutputSampleRate ?? null;
      this.pausedPositionSeconds = safePositionSeconds;
      this.clock.reset(safePositionSeconds, sampleRate);
      this.emitStatus();
      return this.getStatus();
    }

    return this.playLocalFile({
      filePath: this.currentFilePath,
      trackId: this.currentTrackId ?? undefined,
      startSeconds: safePositionSeconds,
      output: this.currentOutputSettings,
    });
  }

  getStatus(): AudioStatus {
    this.updatePositionFromOutput();

    const status = defaultStatus(this.isNativeHostAvailable());
    const plan = this.currentPlan;

    return {
      ...status,
      host: this.hostStatus,
      state: this.state,
      outputDeviceId: this.currentDevice?.id ?? null,
      outputDeviceName: this.currentOutputDeviceName ?? this.currentDevice?.name ?? null,
      outputDeviceType: this.currentOutputDeviceType,
      outputBackend: this.currentOutputBackend,
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
    const decoderOutputSampleRate =
      outputMode === 'shared'
        ? actualDeviceSampleRate ?? requestedOutputSampleRate
        : requestedOutputSampleRate;
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
    this.currentOutputBackend = typeof readyDevice.backend === 'string' ? readyDevice.backend : null;
    this.currentOutputDeviceType = typeof readyDevice.deviceType === 'string' ? readyDevice.deviceType : null;
    this.currentOutputDeviceName = typeof readyDevice.deviceName === 'string' ? readyDevice.deviceName : null;
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
    const readyDeviceName = typeof readyDevice.deviceName === 'string' ? readyDevice.deviceName : null;
    const readySampleRate =
      normalizePositiveInteger(readyDevice.sharedDeviceSampleRate) ??
      normalizePositiveInteger(readyDevice.sharedSampleRate) ??
      ready.actualDeviceSampleRate;
    const resolvedDevice =
      readyDeviceName || readySampleRate
        ? {
            ...(selectedDevice ?? createDeviceFromOutputSettings(this.currentOutputSettings) ?? {
              id: `${this.currentOutputSettings.outputMode ?? 'shared'}:ready`,
              index: this.currentOutputSettings.deviceIndex ?? -1,
              name: 'Selected output',
              outputMode: this.currentOutputSettings.outputMode === 'asio' ? 'asio' : 'shared',
              sampleRate: null,
              sharedDeviceSampleRate: null,
              isDefault: false,
            }),
            name: readyDeviceName ?? selectedDevice?.name ?? this.currentOutputSettings.deviceName ?? 'Selected output',
            sampleRate: readySampleRate,
            sharedDeviceSampleRate: readySampleRate,
          }
        : selectedDevice;

    this.currentDevice = resolvedDevice;
    this.currentPlan = this.createSampleRatePlan(
      this.currentProbe,
      this.currentOutputSettings,
      resolvedDevice,
      ready.actualDeviceSampleRate,
    );
    this.clock.setSampleRate(ready.actualDeviceSampleRate ?? this.currentPlan.requestedOutputSampleRate);
  }

  private assertReadySampleRateConsistent(): void {
    const plan = this.currentPlan;

    if (!plan || plan.outputMode === 'shared' || plan.actualDeviceSampleRate === null) {
      return;
    }

    if (plan.actualDeviceSampleRate !== plan.requestedOutputSampleRate) {
      throw new Error(
        `${plan.outputMode}_output_sample_rate_mismatch:${plan.requestedOutputSampleRate}->${plan.actualDeviceSampleRate}`,
      );
    }
  }

  private resolveSelectedDevice(outputSettings: AudioOutputSettings): AudioDeviceInfo | null {
    const deviceIndex = Number(outputSettings.deviceIndex);
    const deviceName = outputSettings.deviceName;

    if (!Number.isInteger(deviceIndex) && !deviceName) {
      return null;
    }

    const outputMode = normalizeOutputMode(outputSettings.outputMode);
    const expectedDeviceMode = outputMode === 'asio' ? 'asio' : 'shared';

    const devices = this.deviceService.listDevices().filter((device) => device.outputMode === expectedDeviceMode);

    if (deviceName) {
      const nameMatch = devices.find((device) => device.name === deviceName);
      if (nameMatch) {
        return nameMatch;
      }
    }

    if (Number.isInteger(deviceIndex)) {
      return devices.find((device) => device.index === deviceIndex) ?? null;
    }

    return null;
  }

  private createBridgeStartCandidates(outputSettings: AudioOutputSettings): Array<AudioDeviceInfo | null> {
    if (hasExplicitDeviceSelection(outputSettings)) {
      return [createDeviceFromOutputSettings(outputSettings)];
    }

    return [null];
  }

  private async startOutputBridgeForProbe(
    probe: AudioProbeResult,
    token: number,
    startSeconds: number,
  ): Promise<BridgeStartResult> {
    if (!this.currentOutputSettings) {
      throw new Error('audio output settings unavailable');
    }

    const candidates = this.createBridgeStartCandidates(this.currentOutputSettings);
    let lastError: Error | null = null;

    for (const candidate of candidates) {
      this.assertCurrentRun(token);
      this.currentDevice = candidate;
      this.currentPlan = this.createSampleRatePlan(probe, this.currentOutputSettings, this.currentDevice);
      this.logger(
        `[AudioSession] sample-rate plan: file=${this.currentPlan.fileSampleRate ?? 'n/a'} decoder=${
          this.currentPlan.decoderOutputSampleRate
        } requested=${this.currentPlan.requestedOutputSampleRate} mode=${this.currentPlan.outputMode} device=${
          candidate ? `${candidate.index}:${candidate.name}` : 'default'
        }`,
      );
      this.clock.reset(startSeconds, this.currentPlan.requestedOutputSampleRate);

      const bridge = this.createBridge();
      this.bridge = bridge;
      this.attachBridgeEvents(bridge, token);

      const outputMode = this.currentPlan.outputMode;

      try {
        const ready = await bridge.start({
          requestedOutputSampleRate: this.currentPlan.requestedOutputSampleRate,
          channels: probe.channels,
          deviceIndex: candidate?.index ?? this.currentOutputSettings.deviceIndex,
          deviceName: candidate?.name ?? this.currentOutputSettings.deviceName,
          asio: outputMode === 'asio',
          exclusive: outputMode === 'exclusive',
          volume: this.currentOutputSettings.volume,
          startSeconds,
          playbackRate: 1,
        });

        return { bridge, plan: this.currentPlan, ready };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.logger(`[AudioSession] output start failed: ${lastError.message}`);
        bridge.stop();
        if (this.bridge === bridge) {
          this.bridge = null;
        }

        if (hasExplicitDeviceSelection(this.currentOutputSettings)) {
          throw lastError;
        }
      }
    }

    throw lastError ?? new Error('no output device candidates available');
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
    this.stopResources();
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
