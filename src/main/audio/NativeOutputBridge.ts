import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithStdioTuple } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';
import { Writable } from 'node:stream';
import electron from 'electron';
import type {
  NativeBridgeReadyMessage,
  NativeBridgeReadyResult,
  NativeOutputStartOptions,
} from './audioTypes';

type BridgeSpawnOptions = SpawnOptionsWithStdioTuple<'pipe', 'pipe', 'pipe'> & {
  windowsHide: boolean;
};

export type HostSpawner = (
  file: string,
  args: string[],
  options: BridgeSpawnOptions,
) => ChildProcessWithoutNullStreams;

export type NativeOutputBridgeDependencies = {
  hostBinary?: string | null;
  spawn?: HostSpawner;
  readyTimeoutMs?: number;
  logger?: (message: string) => void;
};

const getElectronAppPath = (): string | null => {
  const electronApp = (electron as unknown as { app?: { getAppPath: () => string } }).app;

  try {
    return electronApp?.getAppPath?.() ?? null;
  } catch {
    return null;
  }
};

export const resolveHostBinary = (): string | null => {
  const exe = process.platform === 'win32' ? 'echo-audio-host.exe' : 'echo-audio-host';
  const appPath = getElectronAppPath();
  const candidates: string[] = [];

  if (process.resourcesPath) {
    candidates.push(join(process.resourcesPath, exe));
  }

  if (appPath) {
    candidates.push(join(appPath, '..', exe));
    candidates.push(join(appPath, '..', '..', 'electron-app', 'build', exe));
    candidates.push(join(appPath, 'electron-app', 'build', exe));
  }

  candidates.push(join(process.cwd(), 'electron-app', 'build', exe));
  candidates.push(join(process.cwd(), 'build', exe));
  candidates.push(join(process.cwd(), '..', 'ECHO', 'electron-app', 'build', exe));

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
};

export const isNativeOutputBridgeAvailable = (): boolean => resolveHostBinary() !== null;

class BridgeWritable extends Writable {
  private isClosed = false;

  constructor(private readonly target: Writable) {
    super();

    target.on('error', () => {
      this.isClosed = true;
    });
    target.on('close', () => {
      this.isClosed = true;
    });
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (this.isClosed || this.target.destroyed || this.target.writableEnded || !this.target.writable) {
      this.isClosed = true;
      callback();
      return;
    }

    try {
      this.target.write(chunk, (error: Error | null | undefined) => {
        if (error) {
          this.isClosed = true;
        }

        callback();
      });
    } catch {
      this.isClosed = true;
      callback();
    }
  }

  override _final(callback: (error?: Error | null) => void): void {
    if (this.isClosed || this.target.destroyed || this.target.writableEnded || !this.target.writable) {
      callback();
      return;
    }

    try {
      this.target.end(callback);
    } catch {
      this.isClosed = true;
      callback();
    }
  }
}

export class NativeOutputBridge extends EventEmitter {
  private readonly spawn: HostSpawner;
  private readonly readyTimeoutMs: number;
  private readonly logger: (message: string) => void;
  private hostBinary: string | null;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private bridgeWritable: BridgeWritable | null = null;
  private framesConsumed = 0;
  private frameOffset = 0;
  private requestedOutputSampleRate = 44100;
  private actualDeviceSampleRate: number | null = null;
  private startSeconds = 0;
  private playbackRate = 1;
  private ready = false;
  private ended = false;
  private stopRequested = false;
  private readyTimer: NodeJS.Timeout | null = null;
  private readyMessage: NativeBridgeReadyMessage | null = null;

  constructor(dependencies: NativeOutputBridgeDependencies = {}) {
    super();
    this.hostBinary = dependencies.hostBinary ?? null;
    this.spawn = dependencies.spawn ?? nodeSpawn;
    this.readyTimeoutMs = dependencies.readyTimeoutMs ?? 5000;
    this.logger = dependencies.logger ?? (() => undefined);
    this.on('error', () => undefined);
  }

  get writable(): Writable | null {
    return this.bridgeWritable;
  }

  get isReady(): boolean {
    return this.ready;
  }

  get isEnded(): boolean {
    return this.ended;
  }

  get deviceInfo(): NativeBridgeReadyMessage | null {
    return this.readyMessage;
  }

  get requestedSampleRate(): number {
    return this.requestedOutputSampleRate;
  }

  get actualSampleRate(): number | null {
    return this.actualDeviceSampleRate;
  }

  async start(options: NativeOutputStartOptions): Promise<NativeBridgeReadyResult> {
    return new Promise((resolve, reject) => {
      const bin = this.hostBinary ?? resolveHostBinary();

      if (!bin) {
        reject(new Error('echo-audio-host binary not found'));
        return;
      }

      this.hostBinary = bin;
      this.requestedOutputSampleRate = options.requestedOutputSampleRate;
      this.actualDeviceSampleRate = null;
      this.startSeconds = options.startSeconds ?? 0;
      this.playbackRate = options.playbackRate ?? 1;
      this.framesConsumed = 0;
      this.frameOffset = 0;
      this.ready = false;
      this.ended = false;
      this.stopRequested = false;
      this.readyMessage = null;

      const args = this.createSpawnArgs(options);
      let settled = false;
      const settleResolve = (value: NativeBridgeReadyResult): void => {
        if (settled) {
          return;
        }

        settled = true;
        resolve(value);
      };
      const settleReject = (error: Error): void => {
        if (settled) {
          return;
        }

        settled = true;
        reject(error);
      };

      this.logger(`[NativeOutputBridge] spawn: ${bin} ${args.join(' ')}`);
      this.proc = this.spawn(bin, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.bridgeWritable = new BridgeWritable(this.proc.stdin);

      const stdout = readline.createInterface({ input: this.proc.stdout });
      stdout.on('line', (line) => {
        this.handleStdoutLine(line, settleResolve);
      });

      const stderr = readline.createInterface({ input: this.proc.stderr });
      stderr.on('line', (line) => {
        this.logger(`[echo-audio-host] ${line}`);
      });

      this.proc.on('error', (error) => {
        settleReject(error);
        this.emit('error', error);
      });

      this.proc.on('exit', (code, signal) => {
        const wasReady = this.ready;
        const intentional = this.stopRequested;
        this.ready = false;
        this.stopRequested = false;
        this.clearReadyTimer();

        if (intentional || this.ended || code === 0) {
          return;
        }

        const error =
          code === -2
            ? new Error('exclusive_denied')
            : new Error(code != null ? `exit_code_${code}` : `exit_signal_${signal ?? '?'}`);

        if (!wasReady) {
          settleReject(error);
          return;
        }

        this.emit('error', error);
      });

      this.clearReadyTimer();
      this.readyTimer = setTimeout(() => {
        this.readyTimer = null;
        if (!this.ready) {
          this.stop();
          settleReject(new Error('timeout waiting for echo-audio-host ready'));
        }
      }, this.readyTimeoutMs);
    });
  }

  getPositionSeconds(): number {
    const sampleRate = this.actualDeviceSampleRate ?? this.requestedOutputSampleRate;

    if (sampleRate <= 0) {
      return this.startSeconds;
    }

    const localFrames = Math.max(0, this.framesConsumed - this.frameOffset);
    return this.startSeconds + (localFrames / sampleRate) * this.playbackRate;
  }

  resetOutputClock(startSeconds = 0, playbackRate = 1): void {
    this.frameOffset = this.framesConsumed;
    this.startSeconds = startSeconds;
    this.playbackRate = playbackRate;
    this.ended = false;
  }

  stop(): void {
    this.clearReadyTimer();
    this.stopRequested = true;

    if (this.bridgeWritable) {
      try {
        this.bridgeWritable.destroy();
      } catch {
        // Best-effort child cleanup.
      }
      this.bridgeWritable = null;
    }

    if (this.proc) {
      try {
        this.proc.stdin.destroy();
      } catch {
        // Best-effort child cleanup.
      }

      try {
        this.proc.kill('SIGKILL');
      } catch {
        // Best-effort child cleanup.
      }

      this.proc = null;
    }

    this.ready = false;
  }

  private createSpawnArgs(options: NativeOutputStartOptions): string[] {
    const args = ['-sr', String(options.requestedOutputSampleRate), '-ch', String(options.channels)];
    const deviceIndex = Number(options.deviceIndex ?? -1);

    if (Number.isInteger(deviceIndex) && deviceIndex >= 0) {
      args.push('-device-index', String(deviceIndex));
    } else if (options.deviceName) {
      args.push('-device', options.deviceName);
    }

    if (options.asio) {
      args.push('-asio');
    }

    if (options.exclusive && !options.asio) {
      args.push('-exclusive');
    }

    const volume = Number(options.volume ?? 1);
    if (Number.isFinite(volume) && Math.abs(volume - 1) > 1e-6) {
      args.push('-vol', String(Math.max(0, Math.min(1, volume))));
    }

    return args;
  }

  private handleStdoutLine(
    line: string,
    resolveReady: (value: NativeBridgeReadyResult) => void,
  ): void {
    let message: NativeBridgeReadyMessage & { pos?: unknown; event?: unknown };

    try {
      message = JSON.parse(line) as NativeBridgeReadyMessage & { pos?: unknown; event?: unknown };
    } catch {
      return;
    }

    if (message.ready) {
      this.ready = true;
      this.readyMessage = message;
      this.clearReadyTimer();

      if (typeof message.sampleRate === 'number' && message.sampleRate > 0) {
        this.actualDeviceSampleRate = message.sampleRate;
      }

      const result: NativeBridgeReadyResult = {
        ok: true,
        device: message,
        requestedOutputSampleRate: this.requestedOutputSampleRate,
        actualDeviceSampleRate: this.actualDeviceSampleRate,
      };
      this.emit('ready', result);
      resolveReady(result);
    }

    if (typeof message.pos === 'number') {
      this.framesConsumed = Math.max(0, message.pos);
      this.emit('position', this.framesConsumed);
    }

    if (message.event === 'ended') {
      if (this.stopRequested) {
        return;
      }

      this.ended = true;
      this.emit('ended');
    }

    if (message.event === 'error') {
      this.emit('error', new Error('echo-audio-host error event'));
    }
  }

  private clearReadyTimer(): void {
    if (!this.readyTimer) {
      return;
    }

    clearTimeout(this.readyTimer);
    this.readyTimer = null;
  }
}
