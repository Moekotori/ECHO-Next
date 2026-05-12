// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ArtistsPage } from './ArtistsPage';
import type { LibraryArtist, LibraryPage } from '../../shared/types/library';

vi.mock('../components/artist/ArtistDetailView', () => ({
  ArtistDetailView: ({ artist, onBack }: { artist: LibraryArtist; onBack: () => void }) => (
    <div>
      <h1>Detail: {artist.name}</h1>
      <button type="button" onClick={onBack}>
        Back to artists
      </button>
    </div>
  ),
}));

const artist = (id: string, overrides: Partial<LibraryArtist> = {}): LibraryArtist => ({
  id,
  name: `Artist ${id}`,
  sortName: `artist ${id}`,
  role: 'track',
  trackCount: 4,
  albumCount: 1,
  ...overrides,
});

const page = (items: LibraryArtist[], overrides: Partial<LibraryPage<LibraryArtist>> = {}): LibraryPage<LibraryArtist> => ({
  items,
  page: 1,
  pageSize: 96,
  total: items.length,
  hasMore: false,
  ...overrides,
});

const installLibrary = (getArtists: ReturnType<typeof vi.fn>): void => {
  window.echo = {
    library: {
      getArtists,
      getAlbums: vi.fn(),
      getTracks: vi.fn(),
      getAlbumTracks: vi.fn(),
      getArtist: vi.fn(),
      getArtistTracks: vi.fn(),
      getArtistAlbums: vi.fn(),
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
  } as unknown as Window['echo'];
};

const setScrollableArtistWall = (element: HTMLElement): void => {
  Object.defineProperty(element, 'scrollHeight', { configurable: true, value: 2000 });
  Object.defineProperty(element, 'clientHeight', { configurable: true, value: 900 });
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('ArtistsPage', () => {
  it('loads artists from the desktop bridge', async () => {
    const getArtists = vi.fn().mockResolvedValue(page([artist('1', { name: '安田レイ' })], { total: 12 }));
    installLibrary(getArtists);

    render(<ArtistsPage />);

    await waitFor(() => expect(getArtists).toHaveBeenCalledTimes(1));
    expect(getArtists).toHaveBeenCalledWith({ page: 1, pageSize: 96, search: '', sort: 'default' });
    expect(screen.getByText('安田レイ')).toBeTruthy();
    expect(screen.getByText('4 tracks / 1 albums')).toBeTruthy();
    expect(screen.getByText('安田')).toBeTruthy();
  });

  it('loads the next artist page when the wall scrolls near the bottom', async () => {
    const getArtists = vi
      .fn()
      .mockResolvedValueOnce(page([artist('1')], { page: 1, total: 2, hasMore: true }))
      .mockResolvedValueOnce(page([artist('2')], { page: 2, total: 2, hasMore: false }));
    installLibrary(getArtists);

    render(<ArtistsPage />);

    const wall = await screen.findByLabelText('Artist list');
    await waitFor(() => expect(getArtists).toHaveBeenCalledTimes(1));

    setScrollableArtistWall(wall);
    wall.scrollTop = 760;
    fireEvent.scroll(wall);

    await waitFor(() => expect(getArtists).toHaveBeenCalledTimes(2));
    expect(getArtists).toHaveBeenNthCalledWith(2, { page: 2, pageSize: 96, search: '', sort: 'default' });
    expect(screen.getByText('Artist 1')).toBeTruthy();
    expect(screen.getByText('Artist 2')).toBeTruthy();
  });

  it('search and sort reset artist loading to page 1', async () => {
    const getArtists = vi
      .fn()
      .mockResolvedValueOnce(page([artist('1')], { total: 120, hasMore: true }))
      .mockResolvedValueOnce(page([artist('search', { name: '2hollis / Nate Sib' })], { total: 1 }))
      .mockResolvedValueOnce(page([artist('popular')], { total: 1 }));
    installLibrary(getArtists);

    render(<ArtistsPage />);
    await waitFor(() => expect(getArtists).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByPlaceholderText('Search artists'), { target: { value: '2hollis' } });
    await new Promise((resolve) => window.setTimeout(resolve, 275));
    await waitFor(() => expect(getArtists).toHaveBeenCalledTimes(2));
    expect(getArtists).toHaveBeenNthCalledWith(2, { page: 1, pageSize: 96, search: '2hollis', sort: 'default' });

    fireEvent.change(screen.getByDisplayValue('Default'), { target: { value: 'frequent' } });
    await waitFor(() => expect(getArtists).toHaveBeenCalledTimes(3));
    expect(getArtists).toHaveBeenNthCalledWith(3, { page: 1, pageSize: 96, search: '2hollis', sort: 'frequent' });
  });

  it('opens artist detail on click and returns with Back', async () => {
    const getArtists = vi.fn().mockResolvedValue(page([artist('1')]));
    installLibrary(getArtists);

    render(<ArtistsPage />);

    await screen.findByText('Artist 1');
    fireEvent.click(screen.getByText('Artist 1').closest('[role="button"]')!);

    expect(screen.getByText('Detail: Artist 1')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Back to artists' }));

    expect(screen.getByText('Artist 1')).toBeTruthy();
  });

  it('opens artist detail from Enter and Space keys', async () => {
    const getArtists = vi.fn().mockResolvedValue(page([artist('1'), artist('2')]));
    installLibrary(getArtists);

    render(<ArtistsPage />);

    await screen.findByText('Artist 1');
    fireEvent.keyDown(screen.getByText('Artist 1').closest('[role="button"]')!, { key: 'Enter' });
    expect(screen.getByText('Detail: Artist 1')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Back to artists' }));
    fireEvent.keyDown(screen.getByText('Artist 2').closest('[role="button"]')!, { key: ' ' });
    expect(screen.getByText('Detail: Artist 2')).toBeTruthy();
  });
});
