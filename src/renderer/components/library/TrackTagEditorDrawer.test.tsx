// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TrackTagEditorDrawer, applyNetworkCandidateToForm, defaultNetworkFieldSelection } from './TrackTagEditorDrawer';
import type { LibraryTrack, NetworkTagCandidate } from '../../../shared/types/library';

const track = (overrides: Partial<LibraryTrack> = {}): LibraryTrack => ({
  id: 'track-1',
  path: 'D:\\Music\\Local Song.flac',
  title: 'Local Song',
  artist: 'Local Artist',
  album: 'Local Album',
  albumArtist: 'Local Artist',
  trackNo: 1,
  discNo: null,
  year: null,
  genre: null,
  duration: 180,
  codec: 'flac',
  sampleRate: 44100,
  bitDepth: 16,
  bitrate: 900000,
  coverId: null,
  coverThumb: null,
  embeddedMetadataStatus: 'present',
  embeddedCoverStatus: 'missing',
  networkMetadataStatus: 'none',
  fieldSources: {},
  ...overrides,
});

const candidate = (overrides: Partial<NetworkTagCandidate> = {}): NetworkTagCandidate => ({
  id: 'candidate-1',
  provider: 'netease-cloud-music',
  confidence: 0.88,
  title: 'Network Song',
  artist: 'Network Artist',
  album: 'Network Album',
  albumArtist: 'Network Album Artist',
  trackNo: 2,
  discNo: 1,
  year: 2026,
  genre: 'Pop',
  duration: 181,
  coverUrl: 'https://example.test/cover.jpg',
  coverPreviewUrl: 'https://example.test/cover.jpg',
  coverMimeType: 'image/jpeg',
  raw: {},
  ...overrides,
});

const installEcho = (searchNetworkTagCandidates = vi.fn()) => {
  window.echo = {
    library: {
      searchNetworkTagCandidates,
      chooseTrackCover: vi.fn(),
      loadEmbeddedTrackTags: vi.fn(),
      updateTrackTags: vi.fn(),
    },
  } as unknown as typeof window.echo;
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('TrackTagEditorDrawer network tags', () => {
  it('defaults empty fields to checked while keeping existing fields untouched at normal confidence', () => {
    const form = {
      title: 'Local Song',
      artist: 'Local Artist',
      album: '',
      albumArtist: '',
      trackNo: '1',
      discNo: '',
      year: '',
      genre: '',
    };

    expect(defaultNetworkFieldSelection(form, { coverThumb: null }, candidate())).toMatchObject({
      title: false,
      artist: false,
      album: true,
      albumArtist: true,
      trackNo: false,
      discNo: true,
      year: true,
      genre: true,
      cover: true,
    });
  });

  it('allows high-confidence candidates to overwrite existing fields by default', () => {
    const form = {
      title: 'Local Song',
      artist: 'Local Artist',
      album: 'Local Album',
      albumArtist: 'Local Artist',
      trackNo: '1',
      discNo: '',
      year: '',
      genre: '',
    };

    expect(defaultNetworkFieldSelection(form, { coverThumb: 'echo-cover://thumb/current' }, candidate({ confidence: 0.95 }))).toMatchObject({
      title: true,
      artist: true,
      album: true,
      cover: true,
    });
  });

  it('applies only selected candidate fields to the form model', () => {
    const form = {
      title: 'Local Song',
      artist: 'Local Artist',
      album: '',
      albumArtist: '',
      trackNo: '',
      discNo: '',
      year: '',
      genre: '',
    };

    const next = applyNetworkCandidateToForm(form, candidate(), {
      title: false,
      artist: true,
      album: true,
      albumArtist: false,
      trackNo: false,
      discNo: false,
      year: true,
      genre: false,
      cover: false,
    });

    expect(next).toMatchObject({
      title: 'Local Song',
      artist: 'Network Artist',
      album: 'Network Album',
      albumArtist: '',
      year: '2026',
    });
  });

  it('selecting a network candidate updates the visible form but does not save the file', async () => {
    const onSave = vi.fn();
    const searchNetworkTagCandidates = vi.fn().mockResolvedValue([candidate({ confidence: 0.96 })]);
    installEcho(searchNetworkTagCandidates);

    render(<TrackTagEditorDrawer track={track()} isOpen isSaving={false} error={null} onClose={vi.fn()} onSave={onSave} />);

    fireEvent.click(screen.getByRole('button', { name: /从网络加载/ }));
    await screen.findByText('Network Song');
    fireEvent.click(screen.getByText('Network Song'));
    fireEvent.click(screen.getByRole('button', { name: /应用到表单/ }));

    await waitFor(() => expect((document.querySelector('.tag-editor-grid input') as HTMLInputElement).value).toBe('Network Song'));
    expect(onSave).not.toHaveBeenCalled();
  });

  it('toggles all candidate fields from the select-all checkbox', async () => {
    const searchNetworkTagCandidates = vi.fn().mockResolvedValue([candidate({ confidence: 0.88 })]);
    installEcho(searchNetworkTagCandidates);

    render(<TrackTagEditorDrawer track={track()} isOpen isSaving={false} error={null} onClose={vi.fn()} onSave={vi.fn()} />);

    fireEvent.click(document.querySelectorAll('.tag-editor-file button')[2]);
    await screen.findByText('Network Song');
    fireEvent.click(screen.getByText('Network Song'));

    const selectAll = screen.getByLabelText('全选') as HTMLInputElement;
    expect(selectAll.indeterminate).toBe(true);

    fireEvent.click(selectAll);

    const fieldCheckboxes = document.querySelectorAll('.tag-editor-network-fields > div input[type="checkbox"]');
    expect([...fieldCheckboxes].every((checkbox) => (checkbox as HTMLInputElement).checked)).toBe(true);
  });

  it('shows a friendly error when the network provider fails', async () => {
    installEcho(vi.fn().mockRejectedValue(new Error('网络来源暂时不可用，请稍后再试。')));

    render(<TrackTagEditorDrawer track={track()} isOpen isSaving={false} error={null} onClose={vi.fn()} onSave={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /从网络加载/ }));

    expect(await screen.findByText('网络来源暂时不可用，请稍后再试。')).toBeTruthy();
  });
});
