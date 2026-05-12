import { useCallback, useEffect, useRef, useState } from 'react';
import type { WheelEvent } from 'react';
import { Volume1, Volume2, VolumeX } from 'lucide-react';
import type { AudioStatus } from '../../../shared/types/audio';
import { formatPercent } from './playerFormat';

type PlayerVolumeControlProps = {
  status: AudioStatus | null;
  onStatusChange: (status: AudioStatus) => void;
  onError: (message: string) => void;
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
};

const volumeFromStatus = (status: AudioStatus | null): number => {
  return Math.max(0, Math.min(1, status?.volume ?? 1));
};

export const PlayerVolumeControl = ({
  status,
  onStatusChange,
  onError,
  isOpen,
  onOpenChange,
}: PlayerVolumeControlProps): JSX.Element => {
  const [volume, setVolume] = useState(volumeFromStatus(status));
  const rootRef = useRef<HTMLDivElement | null>(null);
  const pendingCommitRef = useRef<number | null>(null);
  const isInteractingRef = useRef(false);
  const Icon = volume <= 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;

  useEffect(() => {
    if (isInteractingRef.current || pendingCommitRef.current !== null) {
      return;
    }

    setVolume(volumeFromStatus(status));
  }, [status]);

  useEffect(() => {
    const getSettings = window.echo?.app?.getSettings;
    const audio = window.echo?.audio;

    if (typeof getSettings !== 'function' || !audio) {
      return;
    }

    let isCancelled = false;
    void getSettings()
      .then(async (settings) => {
        if (isCancelled) {
          return;
        }

        const safeVolume = Math.max(0, Math.min(1, settings.playerVolume));
        setVolume(safeVolume);
        const nextStatus = await audio.setOutput({ volume: safeVolume });
        if (!isCancelled) {
          onStatusChange(nextStatus);
        }
      })
      .catch(() => undefined);

    return () => {
      isCancelled = true;
    };
  }, [onStatusChange]);

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    const handlePointerDown = (event: PointerEvent): void => {
      if (rootRef.current?.contains(event.target as Node)) {
        return;
      }

      onOpenChange(false);
    };

    window.addEventListener('pointerdown', handlePointerDown, true);
    return () => window.removeEventListener('pointerdown', handlePointerDown, true);
  }, [isOpen, onOpenChange]);

  const commitVolume = useCallback(
    async (nextVolume: number): Promise<void> => {
      const audio = window.echo?.audio;
      const safeVolume = Math.max(0, Math.min(1, nextVolume));
      setVolume(safeVolume);
      pendingCommitRef.current = safeVolume;

      if (!audio) {
        onError('Desktop bridge unavailable');
        return;
      }

      try {
        const nextStatus = await audio.setOutput({ volume: safeVolume });
        const setSettings = window.echo?.app?.setSettings;
        if (typeof setSettings === 'function') {
          void setSettings({ playerVolume: safeVolume }).catch(() => undefined);
        }
        if (pendingCommitRef.current === safeVolume) {
          pendingCommitRef.current = null;
          onStatusChange(nextStatus);
        }
      } catch (error) {
        if (pendingCommitRef.current === safeVolume) {
          pendingCommitRef.current = null;
        }
        onError(error instanceof Error ? error.message : String(error));
      }
    },
    [onError, onStatusChange],
  );

  const handleWheel = (event: WheelEvent<HTMLDivElement>): void => {
    event.preventDefault();
    onOpenChange(true);
    const direction = event.deltaY > 0 ? -1 : 1;
    void commitVolume(volume + direction * 0.03);
  };

  const finishInteraction = (nextVolume: number): void => {
    isInteractingRef.current = false;
    void commitVolume(nextVolume);
  };

  return (
    <div className="volume-control" ref={rootRef} onMouseEnter={() => onOpenChange(true)} onWheel={handleWheel}>
      <button
        className="icon-button"
        type="button"
        aria-label="Volume"
        title="Volume"
        onClick={() => onOpenChange(true)}
        onFocus={() => onOpenChange(true)}
      >
        <Icon size={18} />
      </button>
      {isOpen ? (
        <div className="volume-popover">
          <span>{formatPercent(volume)}</span>
          <input
            aria-label="Volume level"
            max={1}
            min={0}
            onChange={(event) => setVolume(Number(event.currentTarget.value))}
            onBlur={(event) => {
              if (isInteractingRef.current) {
                finishInteraction(Number(event.currentTarget.value));
              }
            }}
            onKeyUp={(event) => {
              if (event.key === 'Enter' || event.key === ' ' || event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End') {
                void commitVolume(Number(event.currentTarget.value));
              }
            }}
            onPointerCancel={(event) => finishInteraction(Number(event.currentTarget.value))}
            onPointerDown={() => {
              isInteractingRef.current = true;
            }}
            onPointerUp={(event) => finishInteraction(Number(event.currentTarget.value))}
            step={0.01}
            type="range"
            value={volume}
          />
        </div>
      ) : null}
    </div>
  );
};
