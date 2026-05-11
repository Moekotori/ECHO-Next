import { execFileSync } from 'node:child_process';
import type { AudioDeviceInfo } from './audioTypes';
import { resolveHostBinary } from './NativeOutputBridge';

export type DeviceServiceDependencies = {
  hostBinary?: string | null;
  execFileSync?: typeof execFileSync;
};

const parsePositiveInteger = (value: string | undefined): number | null => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const parseDeviceListLine = (line: string, outputMode: AudioDeviceInfo['outputMode']): AudioDeviceInfo | null => {
  const parts = line.trim().split('\t');

  if (parts.length < 2) {
    return null;
  }

  const index = Number.parseInt(parts[0], 10);
  if (!Number.isInteger(index) || index < 0) {
    return null;
  }

  return {
    id: `${outputMode}:${index}`,
    index,
    name: parts[1],
    outputMode,
    sampleRate: parsePositiveInteger(parts[2]),
    isDefault: parts[3] === '1',
    sharedDeviceSampleRate: parsePositiveInteger(parts[4]),
  };
};

export class DeviceService {
  private readonly exec: typeof execFileSync;
  private readonly hostBinary: string | null;

  constructor(dependencies: DeviceServiceDependencies = {}) {
    this.exec = dependencies.execFileSync ?? execFileSync;
    this.hostBinary = dependencies.hostBinary ?? null;
  }

  listDevices(): AudioDeviceInfo[] {
    return [...this.listSharedDevices(), ...this.listAsioDevices()];
  }

  listSharedDevices(): AudioDeviceInfo[] {
    return this.runDeviceList(['-list'], 'shared');
  }

  listAsioDevices(): AudioDeviceInfo[] {
    return this.runDeviceList(['-list', '-asio'], 'asio');
  }

  private runDeviceList(args: string[], outputMode: AudioDeviceInfo['outputMode']): AudioDeviceInfo[] {
    const bin = this.hostBinary ?? resolveHostBinary();

    if (!bin) {
      return [];
    }

    try {
      const output = this.exec(bin, args, {
        timeout: 5000,
        encoding: 'utf-8',
      });

      return String(output)
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => parseDeviceListLine(line, outputMode))
        .filter((device): device is AudioDeviceInfo => device !== null);
    } catch {
      return [];
    }
  }
}
