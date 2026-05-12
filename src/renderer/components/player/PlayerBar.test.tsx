// @vitest-environment jsdom
import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AudioStatus } from '../../../shared/types/audio';
import type { EqState } from '../../../shared/types/eq';
import type { LibraryTrack } from '../../../shared/types/library';
import { PlaybackQueueProvider, usePlaybackQueue } from '../../stores/PlaybackQueueProvider';
import { PlayerBar } from './PlayerBar';

const makeTrack = (index: number, overrides: Partial<LibraryTrack> = {}): LibraryTrack => ({
  id: `track-${index}`,
  path: `D:\\Music\\song-${index}.flac`,
  title: `Song ${index}`,
  artist: `Artist ${index}`,
  album: 'Album',
  albumArtist: 'Album Artist',
  trackNo: index,
  discNo: 1,
  year: 2026,
  genre: null,
  duration: 180 + index,
  codec: 'flac',
  sampleRate: 44100,
  bitDepth: 16,
  bitrate: 900000,
  coverId: null,
  coverThumb: null,
  fieldSources: {},
  ...overrides,
});

const audioStatus = (track: LibraryTrack): AudioStatus => ({
  host: 'ready',
  state: 'playing',
  outputDeviceId: null,
  outputDeviceName: null,
  outputDeviceType: null,
  outputBackend: 'wasapi-shared',
  outputMode: 'shared',
  volume: 1,
  currentFilePath: track.path,
  currentTrackId: track.id,
  durationSeconds: track.duration,
  positionSeconds: 4,
  channels: 2,
  codec: track.codec,
  bitDepth: track.bitDepth,
  bitrate: track.bitrate,
  fileSampleRate: track.sampleRate,
  decoderOutputSampleRate: track.sampleRate,
  requestedOutputSampleRate: track.sampleRate,
  actualDeviceSampleRate: track.sampleRate,
  sharedDeviceSampleRate: track.sampleRate,
  resampling: false,
  bitPerfectCandidate: false,
  sampleRateMismatch: false,
  eqEnabled: false,
  dspActive: false,
  preampDb: 0,
  eqPresetName: 'Flat',
  clippingRisk: false,
  bitPerfectDisabledReason: null,
  warnings: [],
  error: null,
});

const eqState = (): EqState => ({
  enabled: false,
  preampDb: 0,
  presetId: 'flat',
  presetName: 'Flat',
  clippingRisk: false,
  bands: [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000].map((frequencyHz) => ({
    frequencyHz,
    gainDb: 0,
    q: 1,
  })),
});

const QueueSeed = ({ tracks }: { tracks: LibraryTrack[] }): JSX.Element => {
  const { setCurrentTrackId, setQueue } = usePlaybackQueue();

  useEffect(() => {
    setQueue(tracks);
    setCurrentTrackId(tracks[0]?.id ?? null);
  }, [setCurrentTrackId, setQueue, tracks]);

  return <PlayerBar />;
};

const ExternalPlaySeed = ({ track }: { track: LibraryTrack }): JSX.Element => {
  const { playTrack } = usePlaybackQueue();

  useEffect(() => {
    void playTrack(track);
  }, [playTrack, track]);

  return <PlayerBar />;
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('PlayerBar', () => {
  it('shows cover art for a track started outside the SongsPage loaded queue', async () => {
    const albumTrack = makeTrack(7, {
      title: 'Album Detail Track',
      artist: 'Album Detail Artist',
      coverThumb: 'echo-cover://album/cover-7',
    });

    window.echo = {
      playback: {
        getStatus: vi.fn().mockResolvedValue({
          state: 'playing',
          currentTrackId: null,
          positionMs: 0,
          durationMs: albumTrack.duration * 1000,
          filePath: albumTrack.path,
        }),
        playLocalFile: vi.fn().mockResolvedValue({
          state: 'playing',
          currentTrackId: albumTrack.id,
          positionMs: 0,
          durationMs: albumTrack.duration * 1000,
          filePath: albumTrack.path,
        }),
        play: vi.fn(),
        pause: vi.fn(),
        stop: vi.fn(),
        seek: vi.fn(),
        openLocalAudioFile: vi.fn(),
      },
      audio: {
        getStatus: vi.fn().mockResolvedValue({
          ...audioStatus(albumTrack),
          currentTrackId: null,
        }),
        listDevices: vi.fn(),
        setOutput: vi.fn(),
      },
      eq: {
        getState: vi.fn().mockResolvedValue(eqState()),
        setEnabled: vi.fn().mockResolvedValue(eqState()),
        setBandGain: vi.fn().mockResolvedValue(eqState()),
        setPreamp: vi.fn().mockResolvedValue(eqState()),
        setPreset: vi.fn().mockResolvedValue(eqState()),
        reset: vi.fn().mockResolvedValue(eqState()),
        listPresets: vi.fn().mockResolvedValue([]),
        savePreset: vi.fn(),
        deletePreset: vi.fn().mockResolvedValue([]),
      },
      library: {
        getTracks: vi.fn(),
        getAlbums: vi.fn(),
        getAlbumTracks: vi.fn(),
        getSummary: vi.fn(),
        chooseFolder: vi.fn(),
        addFolder: vi.fn(),
        getFolders: vi.fn(),
        removeFolder: vi.fn(),
        scanFolder: vi.fn(),
        getScanStatus: vi.fn(),
        cancelScan: vi.fn(),
        getDiagnostics: vi.fn(),
      },
      app: {
        getVersion: vi.fn(),
        minimize: vi.fn(),
        toggleMaximize: vi.fn(),
        close: vi.fn(),
      },
    } as unknown as Window['echo'];

    const { container } = render(
      <PlaybackQueueProvider>
        <ExternalPlaySeed track={albumTrack} />
      </PlaybackQueueProvider>,
    );

    await screen.findByText('Album Detail Track');
    expect(screen.getByText('Album Detail Artist')).toBeTruthy();
    expect(container.querySelector('.player-cover img')?.getAttribute('src')).toBe('echo-cover://album/cover-7');
    expect(screen.queryByText(/\.flac$/i)).toBeNull();
    expect(screen.queryByText('Local file')).toBeNull();
  });

  it('keeps the newly queued next track visible when audio status still reports the previous track', async () => {
    const firstTrack = makeTrack(1);
    const secondTrack = makeTrack(2);
    let playbackTrack = firstTrack;

    window.echo = {
      playback: {
        getStatus: vi.fn().mockImplementation(() =>
          Promise.resolve({
            state: 'playing',
            currentTrackId: playbackTrack.id,
            positionMs: 4000,
            durationMs: playbackTrack.duration * 1000,
            filePath: playbackTrack.path,
          }),
        ),
        playLocalFile: vi.fn().mockImplementation(({ filePath, trackId }: { filePath: string; trackId?: string }) => {
          playbackTrack = trackId === secondTrack.id ? secondTrack : firstTrack;

          return Promise.resolve({
            state: 'playing',
            currentTrackId: trackId ?? playbackTrack.id,
            positionMs: 0,
            durationMs: playbackTrack.duration * 1000,
            filePath,
          });
        }),
        play: vi.fn(),
        pause: vi.fn(),
        stop: vi.fn(),
        seek: vi.fn(),
        openLocalAudioFile: vi.fn(),
      },
      audio: {
        getStatus: vi.fn().mockResolvedValue(audioStatus(firstTrack)),
        listDevices: vi.fn(),
        setOutput: vi.fn(),
      },
      eq: {
        getState: vi.fn().mockResolvedValue(eqState()),
        setEnabled: vi.fn().mockResolvedValue(eqState()),
        setBandGain: vi.fn().mockResolvedValue(eqState()),
        setPreamp: vi.fn().mockResolvedValue(eqState()),
        setPreset: vi.fn().mockResolvedValue(eqState()),
        reset: vi.fn().mockResolvedValue(eqState()),
        listPresets: vi.fn().mockResolvedValue([]),
        savePreset: vi.fn(),
        deletePreset: vi.fn().mockResolvedValue([]),
      },
      library: {
        getTracks: vi.fn(),
        getAlbums: vi.fn(),
        getAlbumTracks: vi.fn(),
        getSummary: vi.fn(),
        chooseFolder: vi.fn(),
        addFolder: vi.fn(),
        getFolders: vi.fn(),
        removeFolder: vi.fn(),
        scanFolder: vi.fn(),
        getScanStatus: vi.fn(),
        cancelScan: vi.fn(),
        getDiagnostics: vi.fn(),
      },
      app: {
        getVersion: vi.fn(),
        minimize: vi.fn(),
        toggleMaximize: vi.fn(),
        close: vi.fn(),
      },
    } as unknown as Window['echo'];

    render(
      <PlaybackQueueProvider>
        <QueueSeed tracks={[firstTrack, secondTrack]} />
      </PlaybackQueueProvider>,
    );

    await screen.findByText('Song 1');
    fireEvent.click(screen.getByRole('button', { name: '下一首' }));

    await waitFor(() => expect(screen.getByText('Song 2')).toBeTruthy());
    expect(screen.queryByText('Song 1')).toBeNull();
  });
});
