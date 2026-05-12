import { useCallback, useEffect, useMemo, useState } from 'react';
import { FileAudio, FolderPlus, Pause, Play, RefreshCw, RotateCw, Settings, Square, Trash2, XCircle } from 'lucide-react';
import type { AudioDeviceInfo, AudioOutputMode, AudioOutputSettings, AudioStatus } from '../../shared/types/audio';
import type { LibraryFolder, LibraryScanStatus } from '../../shared/types/library';
import { EmptyState } from '../components/ui/EmptyState';

const isDevBuild = Boolean((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV);

const formatRate = (value: number | null): string => {
  if (!value) {
    return 'n/a';
  }

  return `${value} Hz`;
};

const formatBool = (value: boolean): string => (value ? 'yes' : 'no');

const statusRows = (status: AudioStatus | null): Array<{ label: string; value: string }> => [
  { label: 'state', value: status?.state ?? 'loading' },
  { label: 'fileSampleRate', value: formatRate(status?.fileSampleRate ?? null) },
  { label: 'decoderOutputSampleRate', value: formatRate(status?.decoderOutputSampleRate ?? null) },
  { label: 'requestedOutputSampleRate', value: formatRate(status?.requestedOutputSampleRate ?? null) },
  { label: 'actualDeviceSampleRate', value: formatRate(status?.actualDeviceSampleRate ?? null) },
  { label: 'sharedDeviceSampleRate', value: formatRate(status?.sharedDeviceSampleRate ?? null) },
  { label: 'outputMode', value: status?.outputMode ?? 'shared' },
  { label: 'resampling', value: formatBool(status?.resampling ?? false) },
  { label: 'bitPerfectCandidate', value: formatBool(status?.bitPerfectCandidate ?? false) },
  { label: 'sampleRateMismatch', value: formatBool(status?.sampleRateMismatch ?? false) },
];

export const SettingsPage = (): JSX.Element => {
  const [status, setStatus] = useState<AudioStatus | null>(null);
  const [devices, setDevices] = useState<AudioDeviceInfo[]>([]);
  const [outputMode, setOutputMode] = useState<AudioOutputMode>('shared');
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [lastOpenedFile, setLastOpenedFile] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [folders, setFolders] = useState<LibraryFolder[]>([]);
  const [folderPathInput, setFolderPathInput] = useState('');
  const [scanStatuses, setScanStatuses] = useState<Record<string, LibraryScanStatus>>({});
  const [libraryError, setLibraryError] = useState<string | null>(null);

  const compatibleDevices = useMemo(
    () => devices.filter((device) => (outputMode === 'asio' ? device.outputMode === 'asio' : device.outputMode === 'shared')),
    [devices, outputMode],
  );
  const selectedDevice = compatibleDevices.find((device) => device.id === selectedDeviceId) ?? null;

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await window.echo.audio.getStatus());
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
    }
  }, []);

  const refreshDevices = useCallback(async () => {
    try {
      const nextDevices = await window.echo.audio.listDevices();
      setDevices(nextDevices);
      setError(null);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
      setDevices([]);
    }
  }, []);

  const refreshFolders = useCallback(async () => {
    try {
      setFolders(await window.echo.library.getFolders());
      setLibraryError(null);
    } catch (refreshError) {
      setLibraryError(refreshError instanceof Error ? refreshError.message : String(refreshError));
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    void refreshDevices();
    void refreshFolders();
    const timer = window.setInterval(() => {
      void refreshStatus();
    }, 1000);

    return () => window.clearInterval(timer);
  }, [refreshDevices, refreshFolders, refreshStatus]);

  useEffect(() => {
    const activeJobs = Object.values(scanStatuses).filter((scan) => scan.status === 'queued' || scan.status === 'running');

    if (activeJobs.length === 0) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      for (const scan of activeJobs) {
        void window.echo.library.getScanStatus(scan.id).then((nextStatus) => {
          setScanStatuses((current) => ({
            ...current,
            [nextStatus.folderId]: nextStatus,
          }));
        });
      }
    }, 1000);

    return () => window.clearInterval(timer);
  }, [scanStatuses]);

  useEffect(() => {
    setOutputMode(status?.outputMode ?? 'shared');
  }, [status?.outputMode]);

  useEffect(() => {
    if (status?.outputDeviceId && devices.some((device) => device.id === status.outputDeviceId)) {
      setSelectedDeviceId(status.outputDeviceId);
    }
  }, [devices, status?.outputDeviceId]);

  useEffect(() => {
    if (compatibleDevices.length === 0) {
      setSelectedDeviceId('');
      return;
    }

    if (!compatibleDevices.some((device) => device.id === selectedDeviceId)) {
      setSelectedDeviceId(compatibleDevices.find((device) => device.isDefault)?.id ?? compatibleDevices[0].id);
    }
  }, [compatibleDevices, selectedDeviceId]);

  const createOutputSettings = useCallback((): AudioOutputSettings => {
    const output: AudioOutputSettings = {
      outputMode,
    };

    if (selectedDevice) {
      output.deviceIndex = selectedDevice.index;
      output.deviceName = selectedDevice.name;
    }

    return output;
  }, [outputMode, selectedDevice]);

  const applyOutputSettings = useCallback(
    async (nextOutputMode = outputMode, nextDeviceId = selectedDeviceId) => {
      const nextDevice =
        devices.find((device) => device.id === nextDeviceId && (nextOutputMode === 'asio' ? device.outputMode === 'asio' : device.outputMode === 'shared')) ??
        null;
      const output: AudioOutputSettings = {
        outputMode: nextOutputMode,
      };

      if (nextDevice) {
        output.deviceIndex = nextDevice.index;
        output.deviceName = nextDevice.name;
      }

      setStatus(await window.echo.audio.setOutput(output));
    },
    [devices, outputMode, selectedDeviceId],
  );

  const handleOutputModeChange = (nextMode: AudioOutputMode): void => {
    setOutputMode(nextMode);
    const nextDevices = devices.filter((device) => (nextMode === 'asio' ? device.outputMode === 'asio' : device.outputMode === 'shared'));
    const nextDeviceId = nextDevices.find((device) => device.isDefault)?.id ?? nextDevices[0]?.id ?? '';
    setSelectedDeviceId(nextDeviceId);
    void applyOutputSettings(nextMode, nextDeviceId);
  };

  const handleDeviceChange = (nextDeviceId: string): void => {
    setSelectedDeviceId(nextDeviceId);
    void applyOutputSettings(outputMode, nextDeviceId);
  };

  const handleOpenAndPlay = async (): Promise<void> => {
    setIsBusy(true);
    setError(null);

    try {
      const filePath = await window.echo.playback.openLocalAudioFile();

      if (!filePath) {
        return;
      }

      const output = createOutputSettings();
      setStatus(await window.echo.audio.setOutput(output));
      await window.echo.playback.playLocalFile({
        filePath,
        output,
      });
      setLastOpenedFile(filePath);
      await refreshStatus();
    } catch (playError) {
      setError(playError instanceof Error ? playError.message : String(playError));
      await refreshStatus();
    } finally {
      setIsBusy(false);
    }
  };

  const handlePause = async (): Promise<void> => {
    await window.echo.playback.pause();
    await refreshStatus();
  };

  const handleStop = async (): Promise<void> => {
    await window.echo.playback.stop();
    await refreshStatus();
  };

  const handleAddFolder = async (): Promise<void> => {
    const folderPath = folderPathInput.trim();

    if (!folderPath) {
      return;
    }

    try {
      const folder = await window.echo.library.addFolder(folderPath);
      const scan = await window.echo.library.scanFolder(folder.id);
      setFolderPathInput('');
      setScanStatuses((current) => ({
        ...current,
        [folder.id]: scan,
      }));
      await refreshFolders();
    } catch (addError) {
      setLibraryError(addError instanceof Error ? addError.message : String(addError));
    }
  };

  const handleScanFolder = async (folderId: string): Promise<void> => {
    try {
      const scan = await window.echo.library.scanFolder(folderId);
      setScanStatuses((current) => ({
        ...current,
        [folderId]: scan,
      }));
    } catch (scanError) {
      setLibraryError(scanError instanceof Error ? scanError.message : String(scanError));
    }
  };

  const handleCancelScan = async (folderId: string, jobId: string): Promise<void> => {
    try {
      const scan = await window.echo.library.cancelScan(jobId);
      setScanStatuses((current) => ({
        ...current,
        [folderId]: scan,
      }));
    } catch (cancelError) {
      setLibraryError(cancelError instanceof Error ? cancelError.message : String(cancelError));
    }
  };

  const handleRemoveFolder = async (folderId: string): Promise<void> => {
    try {
      await window.echo.library.removeFolder(folderId);
      setScanStatuses((current) => {
        const next = { ...current };
        delete next[folderId];
        return next;
      });
      await refreshFolders();
    } catch (removeError) {
      setLibraryError(removeError instanceof Error ? removeError.message : String(removeError));
    }
  };

  const libraryPanel = (
    <section className="audio-dev-panel" aria-label="Library folders">
      <div className="audio-dev-header">
        <div>
          <span className="panel-kicker">Library</span>
          <h2>Folders</h2>
        </div>
        <button className="tool-button" type="button" aria-label="Refresh folders" title="Refresh folders" onClick={() => void refreshFolders()}>
          <RefreshCw size={17} />
        </button>
      </div>

      <div className="library-folder-entry">
        <label className="audio-field">
          <span>folder path</span>
          <input
            type="text"
            placeholder="D:\\Music"
            value={folderPathInput}
            onChange={(event) => setFolderPathInput(event.target.value)}
          />
        </label>
        <button className="audio-command-button" type="button" onClick={() => void handleAddFolder()} disabled={!folderPathInput.trim()}>
          <FolderPlus size={17} />
          <span>Add and scan</span>
        </button>
      </div>

      {libraryError ? <p className="audio-error">{libraryError}</p> : null}

      {folders.length === 0 ? (
        <p className="audio-empty">No library folders have been imported yet.</p>
      ) : (
        <div className="library-folder-list">
          {folders.map((folder) => {
            const scan = scanStatuses[folder.id];
            const isScanning = scan?.status === 'queued' || scan?.status === 'running';

            return (
              <div className="library-folder-row" key={folder.id}>
                <div>
                  <strong>{folder.name}</strong>
                  <span>{folder.path}</span>
                  {scan ? (
                    <small>
                      {scan.status} / {scan.phase} / {scan.processedFiles}/{scan.totalFiles} parsed, {scan.skippedFiles} skipped
                    </small>
                  ) : (
                    <small>Ready</small>
                  )}
                </div>
                <button className="audio-icon-command" type="button" aria-label="Scan folder" title="Scan folder" onClick={() => void handleScanFolder(folder.id)} disabled={isScanning}>
                  <RotateCw size={17} />
                </button>
                <button
                  className="audio-icon-command"
                  type="button"
                  aria-label="Cancel scan"
                  title="Cancel scan"
                  onClick={() => scan && void handleCancelScan(folder.id, scan.id)}
                  disabled={!isScanning || !scan}
                >
                  <XCircle size={17} />
                </button>
                <button className="audio-icon-command danger" type="button" aria-label="Remove folder" title="Remove folder" onClick={() => void handleRemoveFolder(folder.id)}>
                  <Trash2 size={17} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );

  if (!isDevBuild) {
    return (
      <div className="settings-preview page-stack">
        {libraryPanel}
        <div className="settings-row">
          <span>Theme</span>
          <strong>Light</strong>
        </div>
        <div className="settings-row">
          <span>Output mode</span>
          <strong>{status?.outputMode ?? 'Shared'}</strong>
        </div>
        <div className="settings-row">
          <span>Library scan</span>
          <strong>Manual</strong>
        </div>
        <EmptyState
          icon={Settings}
          title="Settings will become a typed API surface."
          description="Audio host acceptance controls are available only in development builds."
          meta="Renderer controls settings; it does not own system integration."
        />
      </div>
    );
  }

  return (
    <div className="settings-preview page-stack">
      {libraryPanel}

      <section className="audio-dev-panel" aria-label="Audio host acceptance">
        <div className="audio-dev-header">
          <div>
            <span className="panel-kicker">Audio Host</span>
            <h1>Native Output Check</h1>
          </div>
          <button className="tool-button" type="button" aria-label="Refresh audio status" title="Refresh audio status" onClick={() => void refreshStatus()}>
            <RefreshCw size={17} />
          </button>
        </div>

        <div className="audio-host-strip">
          <div>
            <span>host</span>
            <strong>{status?.host ?? 'checking'}</strong>
          </div>
          <div>
            <span>mode</span>
            <strong>{outputMode}</strong>
          </div>
          <div>
            <span>device</span>
            <strong>{selectedDevice?.index ?? 'default'}</strong>
          </div>
        </div>

        <div className="audio-controls-grid">
          <label className="audio-field">
            <span>outputMode</span>
            <select value={outputMode} onChange={(event) => handleOutputModeChange(event.target.value as AudioOutputMode)}>
              <option value="shared">shared</option>
              <option value="exclusive">exclusive</option>
              <option value="asio">asio</option>
            </select>
          </label>

          <label className="audio-field">
            <span>device</span>
            <select value={selectedDeviceId} onChange={(event) => handleDeviceChange(event.target.value)} disabled={compatibleDevices.length === 0}>
              {compatibleDevices.length === 0 ? (
                <option value="">No devices</option>
              ) : (
                compatibleDevices.map((device) => (
                  <option value={device.id} key={device.id}>
                    {device.index} - {device.name}
                  </option>
                ))
              )}
            </select>
          </label>

          <button className="audio-command-button" type="button" onClick={() => void handleOpenAndPlay()} disabled={isBusy || status?.host === 'unavailable'}>
            <FileAudio size={17} />
            <span>Open Local Audio</span>
          </button>

          <button className="audio-icon-command" type="button" aria-label="Pause" title="Pause" onClick={() => void handlePause()}>
            <Pause size={17} />
          </button>
          <button className="audio-icon-command" type="button" aria-label="Stop" title="Stop" onClick={() => void handleStop()}>
            <Square size={17} />
          </button>
          <button className="audio-icon-command" type="button" aria-label="Resume" title="Resume" onClick={() => void window.echo.playback.play().then(refreshStatus)}>
            <Play size={17} />
          </button>
        </div>

        {lastOpenedFile ? <p className="audio-file-path">{lastOpenedFile}</p> : null}
        {error ? <p className="audio-error">{error}</p> : null}
      </section>

      <section className="audio-dev-panel" aria-label="Audio devices">
        <div className="audio-dev-header">
          <div>
            <span className="panel-kicker">Devices</span>
            <h2>echo-audio-host output devices</h2>
          </div>
          <button className="tool-button" type="button" aria-label="Refresh devices" title="Refresh devices" onClick={() => void refreshDevices()}>
            <RefreshCw size={17} />
          </button>
        </div>

        {devices.length === 0 ? (
          <p className="audio-empty">No output devices were reported by echo-audio-host.</p>
        ) : (
          <div className="audio-device-table">
            <div className="audio-device-row audio-device-row--head">
              <span>name</span>
              <span>index</span>
              <span>sampleRate</span>
              <span>sharedDeviceSampleRate</span>
              <span>outputMode</span>
            </div>
            {devices.map((device) => (
              <div className="audio-device-row" key={device.id}>
                <strong>{device.name}</strong>
                <span>{device.index}</span>
                <span>{formatRate(device.sampleRate)}</span>
                <span>{formatRate(device.sharedDeviceSampleRate)}</span>
                <span>{device.outputMode}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="audio-dev-panel" aria-label="Audio status">
        <div className="audio-dev-header">
          <div>
            <span className="panel-kicker">Status</span>
            <h2>Sample-rate fields</h2>
          </div>
        </div>

        <div className="audio-status-grid">
          {statusRows(status).map((row) => (
            <div className="audio-status-cell" key={row.label}>
              <span>{row.label}</span>
              <strong>{row.value}</strong>
            </div>
          ))}
        </div>

        <div className="audio-warning-list">
          <span>warnings</span>
          {status?.warnings.length ? (
            status.warnings.map((warning) => <strong key={warning}>{warning}</strong>)
          ) : (
            <strong>none</strong>
          )}
        </div>
      </section>
    </div>
  );
};
