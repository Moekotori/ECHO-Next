// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TrackRow } from './TrackRow';
import type { LibraryTrack } from '../../../shared/types/library';

const track = (overrides: Partial<LibraryTrack> = {}): LibraryTrack => ({
  id: 'track-1',
  path: 'D:\\Music\\song.flac',
  title: 'Afraid',
  artist: '2hollis / Nate Sib',
  album: 'afraid',
  albumArtist: '2hollis / Nate Sib',
  trackNo: 7,
  discNo: 1,
  year: 2025,
  genre: null,
  duration: 178,
  codec: 'flac',
  sampleRate: 96000,
  bitDepth: 24,
  bitrate: 900000,
  coverId: null,
  coverThumb: null,
  embeddedMetadataStatus: 'present',
  embeddedCoverStatus: 'missing',
  networkMetadataStatus: 'none',
  fieldSources: {},
  ...overrides,
});

afterEach(() => {
  cleanup();
});

describe('TrackRow', () => {
  it('renders the polished row with cover, copy, hifi tags, duration, and actions', () => {
    render(<TrackRow isPlaying={false} track={track()} />);

    expect(screen.getByText('Afraid')).toBeTruthy();
    expect(screen.getByText('2hollis / Nate Sib - afraid')).toBeTruthy();
    expect(screen.getByText('FLAC')).toBeTruthy();
    expect(screen.getByText('24bit / 96kHz')).toBeTruthy();
    expect(screen.getByText('900kbps')).toBeTruthy();
    expect(screen.getByText('2:58')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Like Afraid' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add to queue Afraid' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'More Afraid' })).toBeTruthy();
  });

  it('handles missing cover and playing state safely', () => {
    render(<TrackRow isPlaying track={track({ coverThumb: null })} />);

    expect(screen.getByRole('listitem').getAttribute('data-playing')).toBe('true');
    expect(screen.getByText('Afraid')).toBeTruthy();
    expect(screen.getByText('Playing')).toBeTruthy();
  });

  it('renders coverThumb as a lazy async image and falls back after load error', () => {
    const coverThumb = 'echo-cover://thumb/cover-1';
    const { container, rerender } = render(<TrackRow isPlaying={false} track={track({ coverThumb })} />);
    const img = container.querySelector('.track-cover img') as HTMLImageElement | null;

    expect(img?.getAttribute('src')).toBe(coverThumb);
    expect(img?.getAttribute('loading')).toBe('lazy');
    expect(img?.getAttribute('decoding')).toBe('async');
    expect(img?.getAttribute('width')).toBe('96');
    expect(img?.getAttribute('height')).toBe('96');
    expect(img?.draggable).toBe(false);

    fireEvent.error(img!);
    expect(container.querySelector('.track-cover img')).toBeNull();
    expect(container.querySelector('.track-cover')?.getAttribute('data-empty')).toBe('true');

    rerender(<TrackRow isPlaying={false} track={track({ coverThumb })} />);
    expect(container.querySelector('.track-cover img')).toBeNull();
  });

  it('calls onPlay once from row click without action button bubbling', () => {
    const onPlay = vi.fn();
    render(<TrackRow isPlaying={false} track={track()} onPlay={onPlay} />);

    fireEvent.click(screen.getByRole('listitem'));
    expect(onPlay).toHaveBeenCalledTimes(1);
    expect(onPlay).toHaveBeenCalledWith(expect.objectContaining({ id: 'track-1' }));

    onPlay.mockClear();
    fireEvent.doubleClick(screen.getByRole('listitem'));
    expect(onPlay).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Like Afraid' }));
    expect(onPlay).not.toHaveBeenCalled();
  });

  it('adds a track to the queue from the row action without playing it', () => {
    const onPlay = vi.fn();
    const onAddToQueue = vi.fn();
    render(<TrackRow isPlaying={false} track={track()} onAddToQueue={onAddToQueue} onPlay={onPlay} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add to queue Afraid' }));

    expect(onAddToQueue).toHaveBeenCalledTimes(1);
    expect(onAddToQueue).toHaveBeenCalledWith(expect.objectContaining({ id: 'track-1' }));
    expect(onPlay).not.toHaveBeenCalled();
  });

  it('marks clickable rows without adding a cover play affordance', () => {
    const { container } = render(<TrackRow isPlaying={false} track={track()} onPlay={vi.fn()} />);

    expect(screen.getByRole('listitem').getAttribute('data-clickable')).toBe('true');
    expect(container.querySelector('.track-cover-play')).toBeNull();
  });
});
