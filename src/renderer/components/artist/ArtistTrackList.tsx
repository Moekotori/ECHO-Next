import { useCallback, useEffect, useRef, useState } from 'react';
import { Disc3, ListPlus, MoreHorizontal, Play, SkipForward } from 'lucide-react';
import type { LibraryPage, LibraryTrack } from '../../../shared/types/library';

type ArtistTrackListProps = {
  artistId: string;
  currentTrackId: string | null;
  onAppendToQueue: (track: LibraryTrack) => void;
  onLoadedTracksChange?: (tracks: LibraryTrack[], total: number, isLoading: boolean) => void;
  onPlayNext: (track: LibraryTrack) => void;
  onPlayTrack: (track: LibraryTrack) => void | Promise<void>;
};

const pageSize = 50;

const formatDuration = (duration: number): string => {
  if (!Number.isFinite(duration) || duration <= 0) {
    return '--:--';
  }

  const totalSeconds = Math.round(duration);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
};

const formatSampleRate = (sampleRate: number | null): string | null => {
  if (!sampleRate) {
    return null;
  }

  const khz = sampleRate / 1000;
  return `${Number.isInteger(khz) ? khz : khz.toFixed(1)}kHz`;
};

const technicalTags = (track: LibraryTrack): string[] =>
  [track.codec?.toUpperCase() ?? null, track.bitDepth ? `${track.bitDepth}bit` : null, formatSampleRate(track.sampleRate)].filter(
    (tag): tag is string => Boolean(tag),
  );

export const ArtistTrackList = ({
  artistId,
  currentTrackId,
  onAppendToQueue,
  onLoadedTracksChange,
  onPlayNext,
  onPlayTrack,
}: ArtistTrackListProps): JSX.Element => {
  const [tracks, setTracks] = useState<LibraryTrack[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const isLoadingRef = useRef(false);

  const loadTracks = useCallback(
    async (nextPage: number, mode: 'replace' | 'append'): Promise<void> => {
      if (mode === 'append' && isLoadingRef.current) {
        return;
      }

      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      isLoadingRef.current = true;
      setIsLoading(true);
      setError(null);

      try {
        const library = window.echo?.library;

        if (!library?.getArtistTracks) {
          setTracks([]);
          setPage(1);
          setTotal(0);
          setHasMore(false);
          setError('Desktop bridge unavailable. Open ECHO Next in Electron to read artist tracks.');
          return;
        }

        const result: LibraryPage<LibraryTrack> = await library.getArtistTracks(artistId, {
          page: nextPage,
          pageSize,
          sort: 'default',
        });

        if (requestIdRef.current !== requestId) {
          return;
        }

        setTracks((current) => (mode === 'append' ? [...current, ...result.items] : result.items));
        setPage(result.page);
        setTotal(result.total);
        setHasMore(result.hasMore);
      } catch (loadError) {
        if (requestIdRef.current === requestId) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      } finally {
        if (requestIdRef.current === requestId) {
          isLoadingRef.current = false;
          setIsLoading(false);
        }
      }
    },
    [artistId],
  );

  useEffect(() => {
    setTracks([]);
    setPage(1);
    setTotal(0);
    setHasMore(false);
    void loadTracks(1, 'replace');
  }, [loadTracks]);

  useEffect(() => {
    onLoadedTracksChange?.(tracks, total, isLoading);
  }, [isLoading, onLoadedTracksChange, total, tracks]);

  const handleLoadMore = useCallback((): void => {
    if (!isLoadingRef.current && hasMore) {
      void loadTracks(page + 1, 'append');
    }
  }, [hasMore, loadTracks, page]);

  return (
    <section className="artist-section artist-track-section" aria-label="Songs by artist">
      <header>
        <div>
          <span>Songs</span>
          <h2>Songs by Artist</h2>
        </div>
        <small>{tracks.length === total ? `${total} tracks` : `${tracks.length} of ${total} tracks`}</small>
      </header>

      <div className="artist-track-list" role="list">
        {tracks.length > 0 ? (
          <div className="artist-track-header" aria-hidden="true">
            <span>Title</span>
            <span>Album</span>
            <span>Signal</span>
            <span>Time</span>
            <span>Actions</span>
          </div>
        ) : null}

        {tracks.map((track) => {
          const isPlaying = track.id === currentTrackId;
          const tags = technicalTags(track);

          return (
            <div className="artist-track-row" data-playing={isPlaying} key={track.id} role="listitem">
              <button className="artist-track-main" type="button" onClick={() => void onPlayTrack(track)}>
                <span className="artist-track-cover" data-empty={!track.coverThumb} aria-hidden="true">
                  {track.coverThumb ? (
                    <img alt="" decoding="async" draggable={false} height={48} loading="lazy" src={track.coverThumb} width={48} />
                  ) : (
                    <Disc3 size={17} />
                  )}
                  <Play className="artist-track-play" size={13} fill="currentColor" aria-hidden="true" />
                </span>
                <span className="artist-track-copy">
                  <strong>{track.title}</strong>
                  <small>{track.artist}</small>
                </span>
              </button>
              <span className="artist-track-album">{track.album || 'Unknown Album'}</span>
              <span className="artist-track-tags" aria-label="Track format">
                {tags.length > 0 ? tags.map((tag) => <em key={`${track.id}-${tag}`}>{tag}</em>) : <em>Local</em>}
              </span>
              <span className="artist-track-duration">{formatDuration(track.duration)}</span>
              <span className="artist-track-actions">
                <button type="button" aria-label={`Play ${track.title} next`} title="Play next" onClick={() => onPlayNext(track)}>
                  <SkipForward size={15} />
                </button>
                <button type="button" aria-label={`Add ${track.title} to queue`} title="Add to queue" onClick={() => onAppendToQueue(track)}>
                  <ListPlus size={15} />
                </button>
                <button type="button" aria-label={`More actions for ${track.title}`} title="More">
                  <MoreHorizontal size={15} />
                </button>
              </span>
            </div>
          );
        })}
      </div>

      {hasMore ? (
        <button className="artist-load-more" type="button" disabled={isLoading} onClick={handleLoadMore}>
          {isLoading ? 'Loading...' : 'Load more songs'}
        </button>
      ) : null}
      {error ? <p className="artist-detail-error">{error}</p> : null}
      {!isLoading && tracks.length === 0 && !error ? <p className="artist-detail-empty">这个艺术家还没有可显示的歌曲。</p> : null}
      {isLoading && tracks.length === 0 ? <p className="artist-detail-loading">Loading songs...</p> : null}
    </section>
  );
};
