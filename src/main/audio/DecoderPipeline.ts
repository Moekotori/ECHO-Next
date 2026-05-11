import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcessByStdio, SpawnOptionsWithStdioTuple } from 'node:child_process';
import type { Readable } from 'node:stream';
import readline from 'node:readline';
import { parseFile } from 'music-metadata';
import type { AudioProbeResult, DecoderRun, PcmDecodeRequest } from './audioTypes';

type DecoderChildProcess = ChildProcessByStdio<null, Readable, Readable>;
type DecoderSpawnOptions = SpawnOptionsWithStdioTuple<'ignore', 'pipe', 'pipe'> & {
  windowsHide: boolean;
};
type DecoderSpawner = (file: string, args: string[], options: DecoderSpawnOptions) => DecoderChildProcess;

export type DecoderPipelineDependencies = {
  ffmpegPath?: string;
  spawn?: DecoderSpawner;
  logger?: (message: string) => void;
};

const normalizePositiveInteger = (value: unknown): number | null => {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? Math.round(numberValue) : null;
};

export class DecoderPipeline {
  private readonly ffmpegPath: string;
  private readonly spawn: DecoderSpawner;
  private readonly logger: (message: string) => void;

  constructor(dependencies: DecoderPipelineDependencies = {}) {
    this.ffmpegPath = dependencies.ffmpegPath ?? process.env.ECHO_FFMPEG_PATH ?? 'ffmpeg';
    this.spawn = dependencies.spawn ?? (nodeSpawn as DecoderSpawner);
    this.logger = dependencies.logger ?? (() => undefined);
  }

  async probeLocalFile(filePath: string): Promise<AudioProbeResult> {
    const metadata = await parseFile(filePath, {
      duration: true,
      skipCovers: true,
    });
    const format = metadata.format;

    return {
      filePath,
      durationSeconds: Math.max(0, Number(format.duration ?? 0)),
      fileSampleRate: normalizePositiveInteger(format.sampleRate),
      channels: Math.max(1, Math.min(8, normalizePositiveInteger(format.numberOfChannels) ?? 2)),
      codec: typeof format.codec === 'string' && format.codec.trim() ? format.codec : null,
      bitDepth: normalizePositiveInteger(format.bitsPerSample),
      bitrate: normalizePositiveInteger(format.bitrate),
    };
  }

  decodeLocalFile(request: PcmDecodeRequest): DecoderRun {
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-ss',
      String(Math.max(0, request.startSeconds)),
      '-i',
      request.filePath,
      '-vn',
      '-f',
      'f32le',
      '-ac',
      String(request.channels),
      '-ar',
      String(request.decoderOutputSampleRate),
      'pipe:1',
    ];
    const proc = this.spawn(this.ffmpegPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stopped = false;

    const stderr = readline.createInterface({ input: proc.stderr });
    stderr.on('line', (line) => {
      this.logger(`[ffmpeg] ${line}`);
    });

    const done = new Promise<void>((resolve, reject) => {
      proc.on('error', (error) => {
        if (stopped) {
          resolve();
          return;
        }

        reject(error);
      });

      proc.on('exit', (code, signal) => {
        if (stopped || code === 0) {
          resolve();
          return;
        }

        reject(new Error(code != null ? `ffmpeg_exit_code_${code}` : `ffmpeg_exit_signal_${signal ?? '?'}`));
      });
    });

    return {
      stream: proc.stdout,
      done,
      stop: () => {
        stopped = true;
        try {
          proc.stdout.destroy();
        } catch {
          // Best-effort decoder cleanup.
        }

        try {
          proc.kill('SIGKILL');
        } catch {
          // Best-effort decoder cleanup.
        }
      },
    };
  }
}
