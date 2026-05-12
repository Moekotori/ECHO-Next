import { useCallback, useMemo, useState } from 'react';
import { ArrowLeft, Disc3, Heart, MoreHorizontal, Play } from 'lucide-react';
import type { LibraryAlbum, LibraryTrack } from '../../../shared/types/library';
import { usePlaybackQueue } from '../../stores/PlaybackQueueProvider';
import { AlbumTrackList } from './AlbumTrackList';

type AlbumDetailViewProps = {
  album: LibraryAlbum;
  onBack: () => void;
};

type AlbumTab = 'tracks' | 'credits' | 'related';

const formatDuration = (duration: number): string | null => {
  if (!Number.isFinite(duration) || duration <= 0) {
    return null;
  }

  const totalMinutes = Math.round(duration / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  return hours > 0 ? `${hours} hr ${minutes} min` : `${totalMinutes} min`;
};

const formatSampleRate = (sampleRate: number | null): string | null => {
  if (!sampleRate) {
    return null;
  }

  return sampleRate >= 1000 ? `${Math.round(sampleRate / 1000)}kHz` : `${sampleRate}Hz`;
};

const formatTechnicalSummary = (track: LibraryTrack | null): string | null => {
  if (!track) {
    return null;
  }

  return [
    track.codec?.toUpperCase() ?? null,
    track.bitDepth ? `${track.bitDepth}bit` : null,
    formatSampleRate(track.sampleRate),
  ]
    .filter(Boolean)
    .join(' / ') || null;
};

export const AlbumDetailView = ({ album, onBack }: AlbumDetailViewProps): JSX.Element => {
  const { currentTrackId, playTrack } = usePlaybackQueue();
  const [activeTab, setActiveTab] = useState<AlbumTab>('tracks');
  const [firstTrack, setFirstTrack] = useState<LibraryTrack | null>(null);
  const [isLoadingFirstTrack, setIsLoadingFirstTrack] = useState(false);
  const [playError, setPlayError] = useState<string | null>(null);
  const duration = formatDuration(album.duration);
  const formatSummary = formatTechnicalSummary(firstTrack);
  const metadata = useMemo(
    () =>
      [
        album.year ? String(album.year) : null,
        `${album.trackCount} ${album.trackCount === 1 ? 'track' : 'tracks'}`,
        duration,
        formatSummary,
      ].filter((item): item is string => Boolean(item)),
    [album.trackCount, album.year, duration, formatSummary],
  );

  const handleFirstTrackChange = useCallback((track: LibraryTrack | null, isLoading: boolean): void => {
    setFirstTrack(track);
    setIsLoadingFirstTrack(isLoading);
  }, []);

  const withAlbumCoverFallback = useCallback(
    (track: LibraryTrack): LibraryTrack => (track.coverThumb || !album.coverThumb ? track : { ...track, coverThumb: album.coverThumb }),
    [album.coverThumb],
  );

  const handlePlayTrack = useCallback(
    async (track: LibraryTrack): Promise<void> => {
      try {
        setPlayError(null);
        await playTrack(withAlbumCoverFallback(track));
      } catch (error) {
        setPlayError(error instanceof Error ? error.message : String(error));
      }
    },
    [playTrack, withAlbumCoverFallback],
  );

  const handlePlayNow = useCallback((): void => {
    if (firstTrack) {
      void handlePlayTrack(firstTrack);
    }
  }, [firstTrack, handlePlayTrack]);

  return (
    <div className="album-detail-page">
      <button className="album-back-button" type="button" onClick={onBack}>
        <ArrowLeft size={17} />
        Albums
      </button>

      <section className="album-detail-hero" aria-label={`${album.title} album details`}>
        <div className="album-detail-cover" data-empty={!album.coverThumb}>
          {album.coverThumb ? (
            <img alt="" decoding="async" draggable={false} height={320} loading="lazy" src={album.coverThumb} width={320} />
          ) : (
            <Disc3 size={58} />
          )}
        </div>

        <div className="album-detail-copy">
          <span className="album-detail-kicker">Album</span>
          <h1>{album.title}</h1>
          <p>{album.albumArtist}</p>

          <div className="album-detail-meta" aria-label="Album metadata">
            {metadata.map((item) => (
              <span key={item}>{item}</span>
            ))}
          </div>

          <div className="album-detail-actions">
            <button className="album-primary-action" type="button" disabled={!firstTrack || isLoadingFirstTrack} onClick={handlePlayNow}>
              <Play size={16} fill="currentColor" />
              {isLoadingFirstTrack ? 'Loading' : 'Play Now'}
            </button>
            <button className="album-circle-action" type="button" aria-label="Favorite album" title="Favorite">
              <Heart size={18} />
            </button>
            <button className="album-circle-action" type="button" aria-label="More album actions" title="More">
              <MoreHorizontal size={19} />
            </button>
          </div>

          {playError ? <p className="album-detail-error">{playError}</p> : null}
        </div>
      </section>

      <nav className="album-tabs" aria-label="Album detail tabs">
        {(['tracks', 'credits', 'related'] as const).map((tab) => (
          <button className="album-tab" data-active={activeTab === tab} key={tab} type="button" onClick={() => setActiveTab(tab)}>
            {tab === 'tracks' ? 'Tracks' : tab === 'credits' ? 'Credits' : 'Related'}
          </button>
        ))}
      </nav>

      {activeTab === 'tracks' ? (
        <AlbumTrackList
          albumId={album.id}
          currentTrackId={currentTrackId}
          onFirstTrackChange={handleFirstTrackChange}
          onPlayTrack={handlePlayTrack}
        />
      ) : (
        <section className="album-detail-placeholder">
          <h2>{activeTab === 'credits' ? 'Credits' : 'Related'}</h2>
          <p>{activeTab === 'credits' ? 'Credits will live here once Library Core stores them.' : 'Related albums will appear here in a later library pass.'}</p>
        </section>
      )}
    </div>
  );
};
