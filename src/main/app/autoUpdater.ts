import { app, dialog } from 'electron';
import electronUpdater from 'electron-updater';
import type { UpdateInfo } from 'electron-updater';
import type { UpdateStatus } from '../../shared/types/updates';

const { autoUpdater } = electronUpdater;

type ReleaseNoteInfo = {
  version?: string;
  note?: string | null;
};

let isUpdaterInitialized = false;
const formatVersion = (version: string): string => (version.startsWith('v') ? version : `v${version}`);
const currentVersion = (): string => formatVersion(app.getVersion());

let updateStatus: UpdateStatus = {
  state: 'idle',
  currentVersion: currentVersion(),
  latestVersion: null,
  releaseName: null,
  releaseNotes: null,
  error: null,
  checkedAt: null,
};

const releaseNotesToText = (releaseNotes: string | ReleaseNoteInfo[] | null | undefined): string | null => {
  if (typeof releaseNotes === 'string') {
    return releaseNotes.trim() || null;
  }

  if (!Array.isArray(releaseNotes)) {
    return null;
  }

  return (
    releaseNotes
      .map((note) => [note.version ? formatVersion(note.version) : null, note.note].filter(Boolean).join('\n'))
      .filter(Boolean)
      .join('\n\n')
      .trim() || null
  );
};

const applyUpdateInfo = (updateInfo: UpdateInfo): void => {
  updateStatus = {
    ...updateStatus,
    latestVersion: formatVersion(updateInfo.version),
    releaseName: updateInfo.releaseName ?? null,
    releaseNotes: releaseNotesToText(updateInfo.releaseNotes),
    checkedAt: new Date().toISOString(),
  };
};

export const getUpdateStatus = (): UpdateStatus => ({
  ...updateStatus,
  currentVersion: currentVersion(),
});

export const setAutoUpdateEnabled = (enabled: boolean): UpdateStatus => {
  if (!enabled) {
    updateStatus = {
      ...updateStatus,
      state: 'disabled',
      error: null,
    };
  } else if (updateStatus.state === 'disabled') {
    updateStatus = {
      ...updateStatus,
      state: 'idle',
      error: null,
    };
  }

  return getUpdateStatus();
};

export const checkForUpdates = async (): Promise<UpdateStatus> => {
  if (updateStatus.state === 'disabled') {
    return getUpdateStatus();
  }

  if (!app.isPackaged) {
    updateStatus = {
      ...updateStatus,
      state: 'not-available',
      error: null,
      checkedAt: new Date().toISOString(),
    };
    return getUpdateStatus();
  }

  updateStatus = {
    ...updateStatus,
    state: 'checking',
    error: null,
  };

  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    updateStatus = {
      ...updateStatus,
      state: 'error',
      error: error instanceof Error ? error.message : String(error),
      checkedAt: new Date().toISOString(),
    };
  }

  return getUpdateStatus();
};

export const initializeAutoUpdater = (enabled: boolean): void => {
  if (isUpdaterInitialized) {
    return;
  }

  isUpdaterInitialized = true;
  setAutoUpdateEnabled(enabled);
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    updateStatus = { ...updateStatus, state: 'checking', error: null };
  });

  autoUpdater.on('update-available', (updateInfo) => {
    applyUpdateInfo(updateInfo);
    updateStatus = { ...updateStatus, state: 'available', error: null };
  });

  autoUpdater.on('update-not-available', (updateInfo) => {
    applyUpdateInfo(updateInfo);
    updateStatus = { ...updateStatus, state: 'not-available', error: null };
  });

  autoUpdater.on('error', (error) => {
    updateStatus = {
      ...updateStatus,
      state: 'error',
      error: error instanceof Error ? error.message : String(error),
      checkedAt: new Date().toISOString(),
    };
    console.warn('[auto-updater] update check failed', error);
  });

  autoUpdater.on('update-downloaded', (updateInfo) => {
    applyUpdateInfo(updateInfo);
    updateStatus = { ...updateStatus, state: 'downloaded', error: null };
    void dialog
      .showMessageBox({
        type: 'info',
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
        cancelId: 1,
        title: 'Update ready',
        message: `ECHO Next ${updateInfo.version} has been downloaded.`,
        detail: 'Restart ECHO Next to finish installing the update.',
      })
      .then((result) => {
        if (result.response === 0) {
          autoUpdater.quitAndInstall();
        }
      });
  });

  if (!app.isPackaged) {
    console.info('[auto-updater] skipped update check outside packaged builds');
    return;
  }

  if (enabled) {
    void checkForUpdates();
  }
};
