import { memo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { LibraryTrack } from '../../../shared/types/library';
import { TrackRow } from './TrackRow';

type TrackListProps = {
  tracks: LibraryTrack[];
  currentTrackId: string | null;
  canLoadMore?: boolean;
  onEndReached?: () => void;
  onPlay?: (track: LibraryTrack) => void;
  onAddToQueue?: (track: LibraryTrack) => void;
  onOpenTrackMenu?: (track: LibraryTrack, position: { x: number; y: number }) => void;
};

export const TrackList = memo(({ tracks, currentTrackId, canLoadMore = false, onEndReached, onPlay, onAddToQueue, onOpenTrackMenu }: TrackListProps): JSX.Element => {
  const scrollParentRef = useRef<HTMLDivElement | null>(null);
  const rowVirtualizer = useVirtualizer({
    count: tracks.length,
    getScrollElement: () => scrollParentRef.current,
    estimateSize: () => 76,
    overscan: 10,
  });

  const handleScroll = (): void => {
    const scrollElement = scrollParentRef.current;

    if (!scrollElement || !canLoadMore || !onEndReached) {
      return;
    }

    const distanceToBottom = scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight;

    if (distanceToBottom < 320) {
      onEndReached();
    }
  };

  return (
    <section className="track-list-shell" aria-label="歌曲列表">
      <div className="track-list" ref={scrollParentRef} role="list" data-virtualized="true" data-estimated-row-height="76" onScroll={handleScroll}>
        {tracks.length === 0 ? (
          <div className="track-empty-state">没有可显示的歌曲。导入音乐文件夹后，这里会显示曲库列表。</div>
        ) : (
          <div className="track-virtual-spacer" style={{ height: rowVirtualizer.getTotalSize() }}>
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const track = tracks[virtualRow.index];

              return (
                <div
                  className="track-virtual-row"
                  key={track.id}
                  ref={rowVirtualizer.measureElement}
                  data-index={virtualRow.index}
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  <TrackRow isPlaying={track.id === currentTrackId} track={track} onPlay={onPlay} onAddToQueue={onAddToQueue} onOpenMenu={onOpenTrackMenu} />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
});

TrackList.displayName = 'TrackList';
