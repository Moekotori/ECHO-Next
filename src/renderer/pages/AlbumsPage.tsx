import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, Disc3, RefreshCw, Search } from 'lucide-react';
import type { LibraryAlbum, LibrarySort } from '../../shared/types/library';

const pageSize = 60;

export const AlbumsPage = (): JSX.Element => {
  const [albums, setAlbums] = useState<LibraryAlbum[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<LibrarySort>('title');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(searchInput.trim());
    }, 250);

    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const loadAlbums = useCallback(
    async (nextPage: number, mode: 'replace' | 'append') => {
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      setIsLoading(true);
      setError(null);

      try {
        const result = await window.echo.library.getAlbums({
          page: nextPage,
          pageSize,
          search,
          sort,
        });

        if (requestIdRef.current !== requestId) {
          return;
        }

        setAlbums((current) => (mode === 'append' ? [...current, ...result.items] : result.items));
        setPage(result.page);
        setTotal(result.total);
        setHasMore(result.hasMore);
      } catch (loadError) {
        if (requestIdRef.current === requestId) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      } finally {
        if (requestIdRef.current === requestId) {
          setIsLoading(false);
        }
      }
    },
    [search, sort],
  );

  useEffect(() => {
    void loadAlbums(1, 'replace');
  }, [loadAlbums]);

  return (
    <div className="albums-page">
      <header className="songs-header">
        <div className="songs-title-group">
          <h1>Albums</h1>
          <span>{total} total</span>
        </div>
        <button className="tool-button album-refresh" type="button" aria-label="Refresh" title="Refresh" onClick={() => loadAlbums(1, 'replace')}>
          <RefreshCw size={17} />
        </button>
      </header>

      <div className="songs-control-row">
        <label className="search-box">
          <Search size={18} aria-hidden="true" />
          <input
            type="search"
            placeholder="Search albums / artists"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
          />
        </label>

        <label className="sort-button sort-select">
          <select value={sort} onChange={(event) => setSort(event.target.value as LibrarySort)}>
            <option value="title">Title</option>
            <option value="artist">Artist</option>
            <option value="recent">Recent</option>
          </select>
          <ChevronDown size={15} />
        </label>
      </div>

      <section className="album-wall" aria-label="Album list">
        {albums.map((album) => (
          <article className="album-card" key={album.id}>
            <div className="album-cover" data-empty={!album.coverThumb} aria-hidden="true">
              {album.coverThumb ? <img alt="" src={album.coverThumb} /> : <Disc3 size={24} />}
            </div>
            <div className="album-copy">
              <strong>{album.title}</strong>
              <span>{album.albumArtist}</span>
              <small>{album.trackCount} tracks</small>
            </div>
          </article>
        ))}
      </section>

      <div className="list-footer">
        <span>{error ?? (isLoading ? 'Loading albums...' : `Loaded ${albums.length} / ${total}`)}</span>
        <button
          className="load-more-button"
          type="button"
          onClick={() => loadAlbums(page + 1, 'append')}
          disabled={!hasMore || isLoading}
        >
          Load more
        </button>
      </div>
    </div>
  );
};
