import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { AudioSession } from './AudioSession';
import { NativeOutputBridge } from './NativeOutputBridge';
import type { HostSpawner } from './NativeOutputBridge';
import type {
  AudioDeviceInfo,
  AudioProbeResult,
  DecoderRun,
  NativeOutputStartOptions,
  PcmDecodeRequest,
} from './audioTypes';

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

  constructor(private readonly probes: Map<string, AudioProbeResult>) {}

  async probeLocalFile(filePath: string): Promise<AudioProbeResult> {
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

class FakeBridge extends EventEmitter {
  readonly writable = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  readonly stop = vi.fn();
  startOptions: NativeOutputStartOptions | null = null;

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
      },
      requestedOutputSampleRate: options.requestedOutputSampleRate,
      actualDeviceSampleRate,
    };
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

  it('ready sample-rate mismatch preserves requested rate and exposes a warning', async () => {
    const { session } = createSessionHarness([probe('441.flac', 44100)], [48000]);

    const status = await session.playLocalFile({
      filePath: '441.flac',
      output: { outputMode: 'exclusive' },
    });

    expect(status.requestedOutputSampleRate).toBe(44100);
    expect(status.actualDeviceSampleRate).toBe(48000);
    expect(status.sampleRateMismatch).toBe(true);
    expect(status.warnings).toContain('actual_device_sample_rate_mismatch:44100->48000');
  });
});

describe('NativeOutputBridge host arguments', () => {
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
});
