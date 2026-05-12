import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { PlayerBar } from '../components/player/PlayerBar';
import { AudioSettingsDrawer } from '../components/player/AudioSettingsDrawer';
import { readRememberedAudioOutput } from '../components/player/audioOutputMemory';
import { Sidebar } from '../components/layout/Sidebar';
import { AppTitleBar } from '../components/layout/AppTitleBar';
import type { AppRoute, AppRouteId } from './routes';
import type { AudioStatus } from '../../shared/types/audio';
import { useI18n } from '../i18n/I18nProvider';

type AppLayoutProps = {
  routes: AppRoute[];
};

export const AppLayout = ({ routes }: AppLayoutProps): JSX.Element => {
  const { t } = useI18n();
  const [activeRouteId, setActiveRouteId] = useState<AppRouteId>('songs');
  const [chromeNotice, setChromeNotice] = useState<string | null>(null);
  const [isAudioDrawerOpen, setIsAudioDrawerOpen] = useState(false);
  const [audioDrawerStatus, setAudioDrawerStatus] = useState<AudioStatus | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const activeRoute = useMemo(
    () => routes.find((route) => route.id === activeRouteId) ?? routes[0],
    [activeRouteId, routes],
  );
  const pageContent: ReactNode = activeRoute.element;

  useEffect(() => {
    const folderInput = folderInputRef.current;

    if (!folderInput) {
      return;
    }

    folderInput.setAttribute('webkitdirectory', '');
    folderInput.setAttribute('directory', '');
  }, []);

  useEffect(() => {
    if (!chromeNotice) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      setChromeNotice(null);
    }, 4200);

    return () => window.clearTimeout(timer);
  }, [chromeNotice]);

  useEffect(() => {
    const handleNavigateImportFolder = (): void => {
      setActiveRouteId('import-folder');
    };
    const handleNavigateQueue = (): void => {
      setActiveRouteId('queue');
    };

    window.addEventListener('app:navigate:import-folder', handleNavigateImportFolder);
    window.addEventListener('app:navigate:queue', handleNavigateQueue);
    return () => {
      window.removeEventListener('app:navigate:import-folder', handleNavigateImportFolder);
      window.removeEventListener('app:navigate:queue', handleNavigateQueue);
    };
  }, []);

  useEffect(() => {
    const audio = window.echo?.audio;

    if (!audio) {
      return;
    }

    const remembered = readRememberedAudioOutput();

    if (!remembered.enabled) {
      return;
    }

    void audio
      .setOutput({
        outputMode: remembered.outputMode,
        deviceIndex: remembered.deviceIndex,
        deviceName: remembered.deviceName,
      })
      .then(setAudioDrawerStatus)
      .catch((error) => {
        console.error('Failed to restore remembered audio output', error);
      });
  }, []);

  const notifyLibraryChanged = useCallback(async (): Promise<void> => {
    try {
      await window.echo?.library.getSummary();
    } catch {
      // Summary warmup is best-effort for direct chrome actions.
    }

    window.dispatchEvent(new Event('library:changed'));
  }, []);

  const handleImportFolder = useCallback(async (): Promise<void> => {
    const library = window.echo?.library;

    if (!library) {
      folderInputRef.current?.click();
      setChromeNotice(t('notice.browserFolderPicker'));
      return;
    }

    try {
      const chosenPath = await library.chooseFolder();

      if (!chosenPath) {
        return;
      }

      const folder = await library.addFolder(chosenPath);
      await library.scanFolder(folder.id);
      await notifyLibraryChanged();
    } catch (error) {
      console.error('Failed to import folder from app chrome', error);
    }
  }, [notifyLibraryChanged, t]);

  const handleImportFile = useCallback(async (): Promise<void> => {
    const playback = window.echo?.playback;
    const audio = window.echo?.audio;

    if (!playback) {
      fileInputRef.current?.click();
      setChromeNotice(t('notice.browserFolderPicker'));
      return;
    }

    try {
      const filePath = await playback.openLocalAudioFile();

      if (!filePath) {
        return;
      }

      const audioStatus = await audio?.getStatus().catch(() => null);
      await playback.playLocalFile({
        filePath,
        output: audioStatus
          ? {
              outputMode: audioStatus.outputMode,
              deviceName: audioStatus.outputDeviceName ?? undefined,
            }
          : undefined,
      });
    } catch (error) {
      console.error('Failed to open local audio file from app chrome', error);
    }
  }, [t]);

  const handleWindowAction = useCallback(async (action: 'minimize' | 'toggleMaximize' | 'close'): Promise<void> => {
    const appApi = window.echo?.app;

    if (!appApi) {
      setChromeNotice(t('notice.windowControlsDesktop'));
      return;
    }

    await appApi[action]();
  }, [t]);

  const handleBrowserFolderPicked = (files: FileList | null): void => {
    if (!files?.length) {
      return;
    }

    setChromeNotice(t('notice.browserFilePicker', { name: `${files.length} file(s)` }));
  };

  const handleBrowserFilePicked = (files: FileList | null): void => {
    const file = files?.[0];

    if (!file) {
      return;
    }

    setChromeNotice(t('notice.browserFilePicker', { name: `"${file.name}"` }));
  };

  return (
    <div className="app-shell">
      <AppTitleBar
        activeRouteId={activeRouteId}
        onRouteChange={setActiveRouteId}
        onImportFile={() => void handleImportFile()}
        onOpenAudioSettings={() => setIsAudioDrawerOpen(true)}
        onMinimize={() => void handleWindowAction('minimize')}
        onToggleMaximize={() => void handleWindowAction('toggleMaximize')}
        onClose={() => void handleWindowAction('close')}
      />

      <Sidebar
        routes={routes}
        activeRouteId={activeRouteId}
        onRouteChange={setActiveRouteId}
        onImportFolder={() => void handleImportFolder()}
        onImportFile={() => void handleImportFile()}
      />

      <main className="page-surface" key={activeRoute.id}>
        {pageContent}
      </main>

      <input
        ref={folderInputRef}
        className="browser-preview-picker"
        type="file"
        multiple
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => handleBrowserFolderPicked(event.target.files)}
      />
      <input
        ref={fileInputRef}
        className="browser-preview-picker"
        type="file"
        accept=".flac,.mp3,.wav,.m4a,.ogg,audio/*"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => handleBrowserFilePicked(event.target.files)}
      />

      {chromeNotice ? (
        <div className="chrome-notice" role="status">
          {chromeNotice}
        </div>
      ) : null}

      <AudioSettingsDrawer
        isOpen={isAudioDrawerOpen}
        status={audioDrawerStatus}
        onClose={() => setIsAudioDrawerOpen(false)}
        onStatusChange={setAudioDrawerStatus}
      />

      <PlayerBar onOpenAudioSettings={() => setIsAudioDrawerOpen(true)} />
    </div>
  );
};
