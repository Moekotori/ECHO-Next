import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { AudioSession } from './AudioSession';
import { DecoderPipeline, resolveDecoderFfmpegPath } from './DecoderPipeline';
import type { DecoderPipelineDependencies } from './DecoderPipeline';
import { NativeOutputBridge, resolveHostBinary } from './NativeOutputBridge';
import type { HostSpawner } from './NativeOutputBridge';
import type {
  AudioDeviceInfo,
  AudioProbeResult,
  DecoderRun,
  NativeBridgeReadyResult,
  NativeOutputStartOptions,
  PcmDecodeRequest,
} from './audioTypes';

const noopLogger = (): void => undefined;

const probe = (filePath: string, fileSampleRate: number): AudioProbeResult => ({
  filePath,
  fileSampleRate,
  durationSeconds: 120,
  channels: 2,
  codec: 'FLAC',
  bitDepth: 24,
  bitrate: 1400000,
});

class FakeDecoder {
  readonly decodeRequests: PcmDecodeRequest[] = [];
  readonly probeRequests: string[] = [];

  constructor(private readonly probes: Map<string, AudioProbeResult>) {}

  async probeLocalFile(filePath: string): Promise<AudioProbeResult> {
    this.probeRequests.push(filePath);
    const result = this.probes.get(filePath);

    if (!result) {
      throw new Error(`missing probe for ${filePath}`);
    }

    return result;
  }

  decodeLocalFile(request: PcmDecodeRequest): DecoderRun {
    this.decodeRequests.push(request);
    const stream = new PassThrough();
    const stop = vi.fn(() => {
      stream.destroy();
    });

    queueMicrotask(() => {
      if (!stream.destroyed) {
        stream.end();
      }
    });

    return {
      stream,
      stop,
      done: Promise.resolve(),
    };
  }
}

class FailingDecoder extends FakeDecoder {
  override decodeLocalFile(request: PcmDecodeRequest): DecoderRun {
    this.decodeRequests.push(request);
    const stream = new PassThrough();

    return {
      stream,
      stop: vi.fn(() => {
        stream.destroy();
      }),
      done: Promise.reject(new Error('ffmpeg_missing')),
    };
  }
}

class FakeBridge extends EventEmitter {
  readonly writable = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  readonly stop = vi.fn();
  startOptions: NativeOutputStartOptions | null = null;
  positionSeconds = 0;

  constructor(private readonly readySampleRate?: number) {
    super();
  }

  async start(options: NativeOutputStartOptions) {
    this.startOptions = options;
    const actualDeviceSampleRate = this.readySampleRate ?? options.requestedOutputSampleRate;

    return {
      ok: true as const,
      device: {
        ready: true,
        sampleRate: actualDeviceSampleRate,
        backend: options.asio ? 'asio' : options.exclusive ? 'wasapi-exclusive' : 'wasapi-shared',
        deviceType: options.asio ? 'ASIO' : options.exclusive ? 'Windows Audio (Exclusive Mode)' : 'Windows Audio (Shared Mode)',
        deviceName: options.deviceName ?? 'Default output',
      },
      requestedOutputSampleRate: options.requestedOutputSampleRate,
      actualDeviceSampleRate,
    };
  }

  getPositionSeconds(): number {
    return this.positionSeconds;
  }
}

class StartupFailingBridge extends EventEmitter {
  readonly writable = null;
  readonly stop = vi.fn();

  async start(): Promise<NativeBridgeReadyResult> {
    throw new Error(
      'echo-audio-host exit_code_1; host="echo-audio-host.exe"; args="-sr 44100 -ch 2"; stderr="Failed to initialize output device"',
    );
  }

  getPositionSeconds(): number {
    return 0;
  }
}

const createSessionHarness = (
  probes: AudioProbeResult[],
  readySampleRates: number[] = [],
  devices: AudioDeviceInfo[] = [],
) => {
  const decoder = new FakeDecoder(new Map(probes.map((item) => [item.filePath, item])));
  const bridges: FakeBridge[] = [];
  let bridgeIndex = 0;
  const session = new AudioSession({
    decoder,
    deviceService: {
      listDevices: () => devices,
    },
    createBridge: () => {
      const bridge = new FakeBridge(readySampleRates[bridgeIndex]);
      bridgeIndex += 1;
      bridges.push(bridge);
      return bridge;
    },
    logger: noopLogger,
  });

  return { decoder, bridges, session };
};

describe('Audio Core sample-rate regression guard', () => {
  it('44.1k file + exclusive requests 44100 and never defaults to 48000', async () => {
    const { bridges, session } = createSessionHarness([probe('441.flac', 44100)]);

    const status = await session.playLocalFile({
      filePath: '441.flac',
      output: { outputMode: 'exclusive' },
    });

    expect(status.fileSampleRate).toBe(44100);
    expect(status.decoderOutputSampleRate).toBe(44100);
    expect(status.requestedOutputSampleRate).toBe(44100);
    expect(bridges[0].startOptions).toMatchObject({
      requestedOutputSampleRate: 44100,
      exclusive: true,
      asio: false,
    });
  });

  it('48k file + exclusive requests 48000', async () => {
    const { bridges, session } = createSessionHarness([probe('48.flac', 48000)]);

    const status = await session.playLocalFile({
      filePath: '48.flac',
      output: { outputMode: 'exclusive' },
    });

    expect(status.requestedOutputSampleRate).toBe(48000);
    expect(bridges[0].startOptions?.requestedOutputSampleRate).toBe(48000);
  });

  it('96k file + exclusive requests 96000', async () => {
    const { bridges, session } = createSessionHarness([probe('96.flac', 96000)]);

    const status = await session.playLocalFile({
      filePath: '96.flac',
      output: { outputMode: 'exclusive' },
    });

    expect(status.requestedOutputSampleRate).toBe(96000);
    expect(bridges[0].startOptions?.requestedOutputSampleRate).toBe(96000);
  });

  it('switching 48k to 44.1k exclusive stops the old bridge and starts 44100', async () => {
    const { bridges, session } = createSessionHarness([probe('48.flac', 48000), probe('441.flac', 44100)]);

    await session.playLocalFile({ filePath: '48.flac', output: { outputMode: 'exclusive' } });
    await session.playLocalFile({ filePath: '441.flac', output: { outputMode: 'exclusive' } });

    expect(bridges[0].stop).toHaveBeenCalledTimes(1);
    expect(bridges[1].startOptions?.requestedOutputSampleRate).toBe(44100);
  });

  it('switching 44.1k to 96k exclusive stops the old bridge and starts 96000', async () => {
    const { bridges, session } = createSessionHarness([probe('441.flac', 44100), probe('96.flac', 96000)]);

    await session.playLocalFile({ filePath: '441.flac', output: { outputMode: 'exclusive' } });
    await session.playLocalFile({ filePath: '96.flac', output: { outputMode: 'exclusive' } });

    expect(bridges[0].stop).toHaveBeenCalledTimes(1);
    expect(bridges[1].startOptions?.requestedOutputSampleRate).toBe(96000);
  });

  it('shared mode keeps file and actual device rates separate and reports resampling', async () => {
    const sharedDevice: AudioDeviceInfo = {
      id: 'shared:0',
      index: 0,
      name: 'Speakers',
      outputMode: 'shared',
      sampleRate: 48000,
      sharedDeviceSampleRate: 48000,
      isDefault: true,
    };
    const { session } = createSessionHarness([probe('441.flac', 44100)], [48000], [sharedDevice]);

    const status = await session.playLocalFile({
      filePath: '441.flac',
      output: { outputMode: 'shared', deviceIndex: 0 },
    });

    expect(status.fileSampleRate).toBe(44100);
    expect(status.requestedOutputSampleRate).toBe(48000);
    expect(status.actualDeviceSampleRate).toBe(48000);
    expect(status.sharedDeviceSampleRate).toBe(48000);
    expect(status.resampling).toBe(true);
    expect(status.warnings).toContain('shared_output_resampling_or_mixer_rate_difference');
  });

  it('prefers stored device name over stale device index after host replacement', async () => {
    const devices: AudioDeviceInfo[] = [
      {
        id: 'shared:0',
        index: 0,
        name: 'TEAC USB AUDIO DEVICE',
        outputMode: 'shared',
        sampleRate: 48000,
        sharedDeviceSampleRate: 48000,
        isDefault: true,
      },
      {
        id: 'shared:6',
        index: 6,
        name: 'VoiceMeeter Aux Input',
        outputMode: 'shared',
        sampleRate: 48000,
        sharedDeviceSampleRate: 48000,
        isDefault: false,
      },
    ];
    const { bridges, session } = createSessionHarness([probe('song.flac', 44100)], [48000], devices);

    await session.playLocalFile({
      filePath: 'song.flac',
      output: { outputMode: 'shared', deviceIndex: 6, deviceName: 'TEAC USB AUDIO DEVICE' },
    });

    expect(bridges[0].startOptions).toMatchObject({
      deviceIndex: 6,
      deviceName: 'TEAC USB AUDIO DEVICE',
    });
  });

  it('uses library probe hints and avoids device enumeration on the playback hot path', async () => {
    const decoder = new FakeDecoder(new Map());
    const bridges: FakeBridge[] = [];
    let listCalls = 0;
    const session = new AudioSession({
      decoder,
      deviceService: {
        listDevices: () => {
          listCalls += 1;
          return [];
        },
      },
      createBridge: () => {
        const bridge = new FakeBridge(48000);
        bridges.push(bridge);
        return bridge;
      },
      logger: noopLogger,
    });

    const status = await session.playLocalFile({
      filePath: 'hinted.flac',
      trackId: 'track-1',
      output: { outputMode: 'shared', deviceIndex: 6, deviceName: 'TEAC USB AUDIO DEVICE' },
      probe: {
        durationSeconds: 123,
        fileSampleRate: 44100,
        channels: 2,
        codec: 'FLAC',
        bitDepth: 24,
        bitrate: 1400000,
      },
    });

    expect(listCalls).toBe(0);
    expect(status.durationSeconds).toBe(123);
    expect(status.fileSampleRate).toBe(44100);
    expect(bridges[0].startOptions).toMatchObject({
      deviceIndex: 6,
      deviceName: 'TEAC USB AUDIO DEVICE',
    });
    expect(decoder.decodeRequests[0]).toMatchObject({
      filePath: 'hinted.flac',
      decoderOutputSampleRate: 48000,
    });
  });

  it('exclusive ready sample-rate mismatch fails before decoder resampling can start', async () => {
    const { decoder, session } = createSessionHarness([probe('441.flac', 44100)], [48000]);

    await expect(
      session.playLocalFile({
        filePath: '441.flac',
        output: { outputMode: 'exclusive' },
      }),
    ).rejects.toThrow('exclusive_output_sample_rate_mismatch:44100->48000');

    const status = session.getStatus();

    expect(status.requestedOutputSampleRate).toBe(44100);
    expect(status.decoderOutputSampleRate).toBe(44100);
    expect(status.actualDeviceSampleRate).toBe(48000);
    expect(status.sampleRateMismatch).toBe(true);
    expect(status.warnings).toContain('actual_device_sample_rate_mismatch:44100->48000');
    expect(status.error).toBe('exclusive_output_sample_rate_mismatch:44100->48000');
    expect(decoder.decodeRequests).toHaveLength(0);
  });

  it('pause stops the active native host and preserves the current position', async () => {
    const { bridges, session } = createSessionHarness([probe('song.flac', 44100)]);

    await session.playLocalFile({ filePath: 'song.flac', output: { outputMode: 'shared' } });
    bridges[0].positionSeconds = 12.5;
    const status = session.pause();

    expect(status.state).toBe('paused');
    expect(status.positionSeconds).toBe(12.5);
    expect(bridges[0].stop).toHaveBeenCalledTimes(1);
  });

  it('play resumes a paused file from the paused position', async () => {
    const { bridges, session } = createSessionHarness([probe('song.flac', 44100)]);

    await session.playLocalFile({ filePath: 'song.flac', output: { outputMode: 'shared' } });
    bridges[0].positionSeconds = 18.25;
    session.pause();
    const status = await session.play();

    expect(status.state).toBe('playing');
    expect(bridges).toHaveLength(2);
    expect(bridges[1].startOptions?.startSeconds).toBe(18.25);
  });

  it('seek while paused moves the stored position without starting playback', async () => {
    const { bridges, session } = createSessionHarness([probe('song.flac', 44100)]);

    await session.playLocalFile({ filePath: 'song.flac', output: { outputMode: 'shared' } });
    bridges[0].positionSeconds = 7;
    session.pause();
    const pausedStatus = await session.seek(33);

    expect(pausedStatus.state).toBe('paused');
    expect(pausedStatus.positionSeconds).toBe(33);
    expect(bridges).toHaveLength(1);

    await session.play();
    expect(bridges).toHaveLength(2);
    expect(bridges[1].startOptions?.startSeconds).toBe(33);
  });

  it('switching output while playing restarts the current file on the new device', async () => {
    const { bridges, decoder, session } = createSessionHarness([probe('song.flac', 44100)]);

    await session.playLocalFile({
      filePath: 'song.flac',
      output: { outputMode: 'shared', deviceIndex: 0, deviceName: 'TEAC USB AUDIO DEVICE' },
    });
    bridges[0].positionSeconds = 21.75;
    const status = await session.setOutput({
      outputMode: 'shared',
      deviceIndex: 5,
      deviceName: 'Mi Monitor (NVIDIA High Definition Audio)',
    });

    expect(status.state).toBe('playing');
    expect(status.outputDeviceId).toBe('shared:5');
    expect(bridges[0].stop).toHaveBeenCalledTimes(1);
    expect(bridges).toHaveLength(2);
    expect(bridges[1].startOptions).toMatchObject({
      startSeconds: 21.75,
      deviceIndex: 5,
      deviceName: 'Mi Monitor (NVIDIA High Definition Audio)',
    });
    expect(decoder.probeRequests).toEqual(['song.flac']);
  });

  it('switching output while paused updates the resume target without starting playback', async () => {
    const { bridges, session } = createSessionHarness([probe('song.flac', 44100)]);

    await session.playLocalFile({
      filePath: 'song.flac',
      output: { outputMode: 'shared', deviceIndex: 0, deviceName: 'TEAC USB AUDIO DEVICE' },
    });
    bridges[0].positionSeconds = 9;
    session.pause();
    const pausedStatus = await session.setOutput({
      outputMode: 'shared',
      deviceIndex: 5,
      deviceName: 'Mi Monitor (NVIDIA High Definition Audio)',
    });

    expect(pausedStatus.state).toBe('paused');
    expect(pausedStatus.outputDeviceId).toBe('shared:5');
    expect(bridges).toHaveLength(1);

    await session.play();
    expect(bridges).toHaveLength(2);
    expect(bridges[1].startOptions).toMatchObject({
      startSeconds: 9,
      deviceIndex: 5,
      deviceName: 'Mi Monitor (NVIDIA High Definition Audio)',
    });
  });
});

describe('NativeOutputBridge host arguments', () => {
  it('resolves the ECHO Next electron-app build host before migration fallbacks', () => {
    const exe = process.platform === 'win32' ? 'echo-audio-host.exe' : 'echo-audio-host';
    const cwd = join('tmp', 'echo-next');
    const nextHost = join(cwd, 'electron-app', 'build', exe);

    const resolved = resolveHostBinary({
      cwd,
      appPath: null,
      resourcesPath: '',
      exists: (candidate) => candidate === nextHost,
    });

    expect(resolved).toBe(nextHost);
  });

  it('returns null when the native host is unavailable', () => {
    const resolved = resolveHostBinary({
      cwd: join('tmp', 'empty-echo-next'),
      appPath: null,
      resourcesPath: '',
      exists: () => false,
      includeMigrationFallback: false,
    });

    expect(resolved).toBeNull();
  });

  it.each([44100, 48000, 96000])(
    'spawns echo-audio-host with -sr %i and -exclusive',
    async (sampleRate) => {
    const spawned: Array<{ file: string; args: string[] }> = [];
    const fakeSpawn = (file: string, args: string[]): ChildProcessWithoutNullStreams => {
      spawned.push({ file, args });
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const child = Object.assign(new EventEmitter(), {
        stdin,
        stdout,
        stderr,
        kill: vi.fn(() => true),
      }) as unknown as ChildProcessWithoutNullStreams;

      queueMicrotask(() => {
        stdout.write(`{"ready":true,"sampleRate":${sampleRate}}\n`);
      });

      return child;
    };
    const bridge = new NativeOutputBridge({
      hostBinary: 'echo-audio-host.exe',
      spawn: fakeSpawn as HostSpawner,
      logger: noopLogger,
    });

    await bridge.start({
      requestedOutputSampleRate: sampleRate,
      channels: 2,
      exclusive: true,
    });

    expect(spawned[0].args).toEqual(expect.arrayContaining(['-sr', String(sampleRate), '-ch', '2', '-exclusive']));
    if (sampleRate !== 48000) {
      expect(spawned[0].args).not.toEqual(expect.arrayContaining(['-sr', '48000']));
    }
    },
  );

  it('passes device name and index so the host can recover from stale indexes', async () => {
    const spawned: Array<{ file: string; args: string[] }> = [];
    const fakeSpawn = (file: string, args: string[]): ChildProcessWithoutNullStreams => {
      spawned.push({ file, args });
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const child = Object.assign(new EventEmitter(), {
        stdin,
        stdout,
        stderr,
        kill: vi.fn(() => true),
      }) as unknown as ChildProcessWithoutNullStreams;

      queueMicrotask(() => {
        stdout.write('{"ready":true,"sampleRate":48000}\n');
      });

      return child;
    };
    const bridge = new NativeOutputBridge({
      hostBinary: 'echo-audio-host.exe',
      spawn: fakeSpawn as HostSpawner,
      logger: noopLogger,
    });

    await bridge.start({
      requestedOutputSampleRate: 48000,
      channels: 2,
      deviceIndex: 6,
      deviceName: 'TEAC USB AUDIO DEVICE',
    });

    expect(spawned[0].args).toEqual(
      expect.arrayContaining(['-device', 'TEAC USB AUDIO DEVICE', '-device-index', '6']),
    );
  });

  it('spawns echo-audio-host with -asio and without -exclusive for ASIO output', async () => {
    const spawned: Array<{ file: string; args: string[] }> = [];
    const fakeSpawn = (file: string, args: string[]): ChildProcessWithoutNullStreams => {
      spawned.push({ file, args });
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const child = Object.assign(new EventEmitter(), {
        stdin,
        stdout,
        stderr,
        kill: vi.fn(() => true),
      }) as unknown as ChildProcessWithoutNullStreams;

      queueMicrotask(() => {
        stdout.write('{"ready":true,"sampleRate":96000,"backend":"asio","deviceType":"ASIO","deviceName":"TEAC ASIO"}\n');
      });

      return child;
    };
    const bridge = new NativeOutputBridge({
      hostBinary: 'echo-audio-host.exe',
      spawn: fakeSpawn as HostSpawner,
      logger: noopLogger,
    });

    await bridge.start({
      requestedOutputSampleRate: 96000,
      channels: 2,
      asio: true,
      exclusive: true,
    });

    expect(spawned[0].args).toEqual(expect.arrayContaining(['-sr', '96000', '-ch', '2', '-asio']));
    expect(spawned[0].args).not.toContain('-exclusive');
  });

  it('allows slow Exclusive host startup to outlive the shared-mode ready timeout', async () => {
    const fakeSpawn = (): ChildProcessWithoutNullStreams => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const child = Object.assign(new EventEmitter(), {
        stdin,
        stdout,
        stderr,
        kill: vi.fn(() => true),
      }) as unknown as ChildProcessWithoutNullStreams;

      setTimeout(() => {
        stdout.write(
          '{"ready":true,"sampleRate":192000,"backend":"wasapi-exclusive","deviceType":"Windows Audio (Exclusive Mode)","deviceName":"TEAC"}\n',
        );
      }, 20);

      return child;
    };
    const bridge = new NativeOutputBridge({
      hostBinary: 'echo-audio-host.exe',
      spawn: fakeSpawn as HostSpawner,
      readyTimeoutMs: 5,
      logger: noopLogger,
    });

    const ready = await bridge.start({
      requestedOutputSampleRate: 192000,
      channels: 2,
      exclusive: true,
    });

    expect(ready.actualDeviceSampleRate).toBe(192000);
    bridge.stop();
  });
});

describe('AudioSession host availability', () => {
  it('reports unavailable when echo-audio-host is missing without throwing', () => {
    const unavailableSession = new AudioSession({
      decoder: new FakeDecoder(new Map()),
      deviceService: { listDevices: () => [] },
      createBridge: () => new FakeBridge(),
      isNativeHostAvailable: () => false,
      logger: noopLogger,
    });

    expect(unavailableSession.getStatus().host).toBe('unavailable');
  });

});

describe('DecoderPipeline ffmpeg resolution', () => {
  it('prefers explicit ffmpegPath over env and ffmpeg-static', () => {
    expect(
      resolveDecoderFfmpegPath({
        ffmpegPath: 'explicit-ffmpeg',
        env: { ECHO_FFMPEG_PATH: 'env-ffmpeg' },
        staticFfmpegPath: 'static-ffmpeg',
      }),
    ).toBe('explicit-ffmpeg');
  });

  it('prefers ECHO_FFMPEG_PATH over ffmpeg-static', () => {
    expect(
      resolveDecoderFfmpegPath({
        env: { ECHO_FFMPEG_PATH: 'env-ffmpeg' },
        staticFfmpegPath: 'static-ffmpeg',
      }),
    ).toBe('env-ffmpeg');
  });

  it('falls back to ffmpeg-static before system ffmpeg', () => {
    expect(
      resolveDecoderFfmpegPath({
        env: {},
        staticFfmpegPath: 'static-ffmpeg',
        systemFfmpegPath: 'system-ffmpeg',
      }),
    ).toBe('static-ffmpeg');
  });

  it('normalizes missing spawn errors to ffmpeg_missing', async () => {
    const spawn: NonNullable<DecoderPipelineDependencies['spawn']> = () => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(() => true),
      });

      queueMicrotask(() => {
        child.emit('error', Object.assign(new Error('spawn missing ENOENT'), { code: 'ENOENT' }));
      });

      return child as unknown as ReturnType<NonNullable<DecoderPipelineDependencies['spawn']>>;
    };
    const decoder = new DecoderPipeline({
      ffmpegPath: 'missing-ffmpeg',
      spawn,
      logger: noopLogger,
    });
    const run = decoder.decodeLocalFile({
      filePath: 'song.flac',
      startSeconds: 0,
      channels: 2,
      decoderOutputSampleRate: 44100,
    });

    await expect(run.done).rejects.toThrow('ffmpeg_missing');
  });

  it('surfaces decoder errors in AudioSession status', async () => {
    const decoder = new FailingDecoder(new Map([['song.flac', probe('song.flac', 44100)]]));
    const session = new AudioSession({
      decoder,
      deviceService: { listDevices: () => [] },
      createBridge: () => new FakeBridge(),
      isNativeHostAvailable: () => true,
      logger: noopLogger,
    });

    await session.playLocalFile({
      filePath: 'song.flac',
      output: { outputMode: 'exclusive' },
    });
    await Promise.resolve();

    expect(session.getStatus().state).toBe('error');
    expect(session.getStatus().error).toBe('ffmpeg_missing');
  });

  it('includes ffmpeg stderr and spawn details when decoding exits non-zero', async () => {
    const spawn: NonNullable<DecoderPipelineDependencies['spawn']> = () => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(() => true),
      });

      queueMicrotask(() => {
        child.stderr.write('Invalid data found when processing input\n');
        child.emit('exit', 1, null);
      });

      return child as unknown as ReturnType<NonNullable<DecoderPipelineDependencies['spawn']>>;
    };
    const decoder = new DecoderPipeline({
      ffmpegPath: 'test-ffmpeg',
      spawn,
      logger: noopLogger,
    });
    const run = decoder.decodeLocalFile({
      filePath: 'broken.flac',
      startSeconds: 0,
      channels: 2,
      decoderOutputSampleRate: 44100,
    });

    await expect(run.done).rejects.toThrow(
      'ffmpeg_exit_code_1; ffmpeg="test-ffmpeg"; args="-hide_banner -loglevel error -nostdin -ss 0 -i broken.flac -vn -f f32le -ac 2 -ar 44100 pipe:1"; stderr="Invalid data found when processing input"',
    );
  });
});

describe('NativeOutputBridge diagnostics', () => {
  it('includes host stderr and spawn details when the native host exits before ready', async () => {
    const fakeSpawn = (): ChildProcessWithoutNullStreams => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const child = Object.assign(new EventEmitter(), {
        stdin,
        stdout,
        stderr,
        kill: vi.fn(() => true),
      }) as unknown as ChildProcessWithoutNullStreams;

      queueMicrotask(() => {
        stderr.write('[echo-audio-host] Failed to initialize output device\n');
        child.emit('exit', 1, null);
      });

      return child;
    };
    const bridge = new NativeOutputBridge({
      hostBinary: 'echo-audio-host.exe',
      spawn: fakeSpawn as HostSpawner,
      logger: noopLogger,
    });

    await expect(
      bridge.start({
        requestedOutputSampleRate: 44100,
        channels: 2,
      }),
    ).rejects.toThrow(
      'echo-audio-host exit_code_1; host="echo-audio-host.exe"; args="-sr 44100 -ch 2"; stderr="[echo-audio-host] Failed to initialize output device"',
    );
  });

  it('propagates native host startup failures into AudioSession status', async () => {
    const session = new AudioSession({
      decoder: new FakeDecoder(new Map([['song.flac', probe('song.flac', 44100)]])),
      deviceService: { listDevices: () => [] },
      createBridge: () => new StartupFailingBridge(),
      isNativeHostAvailable: () => true,
      logger: noopLogger,
    });

    await expect(
      session.playLocalFile({ filePath: 'song.flac', output: { outputMode: 'exclusive' } }),
    ).rejects.toThrow('Failed to initialize output device');
    expect(session.getStatus().state).toBe('error');
    expect(session.getStatus().error).toContain('Failed to initialize output device');
  });
});
