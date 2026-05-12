import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Search, Wand2 } from 'lucide-react';
import type { LibraryTrack, MissingMetadataScanItem, NetworkCandidateList } from '../../../shared/types/library';
import { useI18n } from '../../i18n/I18nProvider';
import { getAudioBridge, getLibraryBridge, getPlaybackBridge } from '../../utils/echoBridge';
import { NetworkCandidateCard } from './NetworkCandidateCard';

const fieldLabels: Record<string, string> = {
  album: '专辑',
  albumArtist: '专辑艺人',
  artist: '歌手',
  coverId: '封面',
  discNo: '碟号',
  genre: '流派',
  title: '标题',
  trackNo: '音轨',
  year: '年份',
};

const resultReasonText = (reason: string | undefined): string => {
  switch (reason) {
    case 'score_below_auto_apply_threshold':
      return '候选可信度还不够自动补全，请用“应用所选”确认。';
    case 'embedded_metadata_not_ready':
      return '本地内嵌元数据还在读取中，暂时不能应用。';
    case 'embedded_metadata_present':
      return '本地内嵌元数据已存在，未覆盖。';
    case 'no_missing_fields':
      return '没有可补全的缺失字段，本地/内嵌字段已保留。';
    case 'candidate_rejected':
      return '这个候选之前已被拒绝。';
    case 'candidate_missing':
      return '候选已不存在，请重新扫描。';
    default:
      return reason ? `未应用：${reason}` : '没有字段被修改。';
  }
};

export const NetworkMetadataPanel = (): JSX.Element => {
  const { t } = useI18n();
  const [trackId, setTrackId] = useState('');
  const [track, setTrack] = useState<LibraryTrack | null>(null);
  const [candidates, setCandidates] = useState<NetworkCandidateList>({ metadata: [], covers: [] });
  const [scanItems, setScanItems] = useState<MissingMetadataScanItem[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [bulkApplying, setBulkApplying] = useState(false);
  const [scanProgress, setScanProgress] = useState<{ label: string; percent: number } | null>(null);
  const [candidateFeedback, setCandidateFeedback] = useState<Record<string, { tone: 'success' | 'info' | 'warning'; text: string }>>({});

  useEffect(() => {
    if (!busy || !scanProgress || scanProgress.percent >= 100) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      setScanProgress((current) => {
        if (!current || current.percent >= 92) {
          return current;
        }

        const increment = current.percent < 55 ? 7 : current.percent < 78 ? 4 : 1;
        return { ...current, percent: Math.min(92, current.percent + increment) };
      });
    }, 450);

    return () => window.clearInterval(timer);
  }, [busy, scanProgress]);

  const findTrackByExactId = useCallback(async (targetTrackId: string): Promise<LibraryTrack | null> => {
    const library = getLibraryBridge();

    if (!library) {
      setMessage('Desktop bridge unavailable. Open ECHO Next in Electron to repair metadata.');
      return null;
    }

    let page = 1;
    let total = Number.POSITIVE_INFINITY;

    while ((page - 1) * 500 < total) {
      const tracks = await library.getTracks({ page, pageSize: 500 });
      const found = tracks.items.find((item) => item.id === targetTrackId) ?? null;

      if (found) {
        return found;
      }

      total = tracks.total;
      page += 1;
    }

    return null;
  }, []);

  const findTrackByInput = useCallback(
    async (input: string): Promise<LibraryTrack | null> => {
      const library = getLibraryBridge();

      if (!library) {
        setMessage('Desktop bridge unavailable. Open ECHO Next in Electron to repair metadata.');
        return null;
      }

      const exactMatch = await findTrackByExactId(input);
      if (exactMatch) {
        return exactMatch;
      }

      const query = input.trim();
      if (!query) {
        return null;
      }

      const tracks = await library.getTracks({ search: query, page: 1, pageSize: 20 });
      return tracks.items[0] ?? null;
    },
    [findTrackByExactId],
  );

  const resolveTargetTrackId = useCallback(async (): Promise<string | null> => {
    const typedTrackId = trackId.trim();
    if (typedTrackId) {
      const found = await findTrackByInput(typedTrackId);
      setTrack(found);
      return found?.id ?? null;
    }

    const playback = getPlaybackBridge();
    const audio = getAudioBridge();

    if (!playback && !audio) {
      setMessage('Desktop bridge unavailable. Open ECHO Next in Electron to repair metadata.');
      return null;
    }

    const [playbackStatus, audioStatus] = await Promise.all([
      playback?.getStatus().catch(() => null) ?? Promise.resolve(null),
      audio?.getStatus().catch(() => null) ?? Promise.resolve(null),
    ]);

    return playbackStatus?.currentTrackId ?? audioStatus?.currentTrackId ?? null;
  }, [findTrackByInput, trackId]);

  const loadTrack = useCallback(async (): Promise<LibraryTrack | null> => {
    const targetTrackId = await resolveTargetTrackId();
    if (!targetTrackId) {
      setTrack(null);
      return null;
    }

    const found = await findTrackByExactId(targetTrackId);
    setTrack(found);
    return found;
  }, [findTrackByExactId, resolveTargetTrackId]);

  const refreshCandidates = useCallback(async (): Promise<void> => {
    try {
      setScanProgress(null);
      const found = await loadTrack();
      if (!found) {
        setMessage(t('settings.library.networkPanel.trackNotFound'));
        return;
      }

      const library = getLibraryBridge();

      if (!library) {
        setMessage('Desktop bridge unavailable. Open ECHO Next in Electron to repair metadata.');
        return;
      }

      const nextCandidates = await library.showNetworkCandidates(found.id);
      setCandidates(nextCandidates);
      setCandidateFeedback({});
      setMessage(
        nextCandidates.metadata.length + nextCandidates.covers.length
          ? null
          : 'No candidates yet. Run repair or scan missing metadata first.',
      );
    } catch (refreshError) {
      setMessage(refreshError instanceof Error ? refreshError.message : String(refreshError));
    }
  }, [loadTrack, t]);

  const repair = useCallback(async (): Promise<void> => {
    setBusy(true);
    setScanProgress(null);

    try {
      const found = await loadTrack();
      if (!found) {
        setMessage(t('settings.library.networkPanel.trackNotFound'));
        return;
      }

      const library = getLibraryBridge();

      if (!library) {
        setMessage('Desktop bridge unavailable. Open ECHO Next in Electron to repair metadata.');
        return;
      }

      const result = await library.repairMissingMetadata(found.id);
      const candidateCount = result.metadata.length + result.covers.length;
      setCandidates({ metadata: result.metadata, covers: result.covers });
      setCandidateFeedback({});
      setMessage(
        result.errors.length
          ? result.errors.join(', ')
          : result.applied.length
            ? `${t('settings.library.networkPanel.appliedCount')} ${result.applied.length}`
            : candidateCount
              ? 'Candidates found, but confidence was below auto-apply. Review and apply selected fields.'
              : 'No candidates found from the enabled providers.',
      );
    } catch (repairError) {
      setMessage(repairError instanceof Error ? repairError.message : String(repairError));
    } finally {
      setBusy(false);
    }
  }, [loadTrack, t]);

  const scanMissing = useCallback(async (): Promise<void> => {
    setBusy(true);
    setScanProgress({ label: t('settings.library.networkPanel.scanPreparing'), percent: 8 });
    setMessage('正在扫描缺失元数据，网络来源较慢时可能需要几十秒...');
    setTrack(null);
    setCandidates({ metadata: [], covers: [] });
    setCandidateFeedback({});

    try {
      const library = getLibraryBridge();

      if (!library) {
        setMessage('Desktop bridge unavailable. Open ECHO Next in Electron to repair metadata.');
        setScanProgress(null);
        return;
      }

      setScanProgress({ label: t('settings.library.networkPanel.scanRunning'), percent: 18 });
      const result = await library.scanMissingMetadata(500);
      setScanItems(result.items);
      setScanProgress({ label: t('settings.library.networkPanel.scanComplete'), percent: 100 });
      setMessage(
        result.errors.length
          ? `${t('settings.library.networkPanel.scanDone')} ${result.scannedCount}; ${t('settings.library.networkPanel.candidates')} ${result.candidateCount}; ${t('settings.library.networkPanel.providerErrors')} ${result.errors.length}`
          : result.candidateCount
            ? `${t('settings.library.networkPanel.scanDone')} ${result.scannedCount}; ${t('settings.library.networkPanel.candidates')} ${result.candidateCount}`
            : `${t('settings.library.networkPanel.scanDone')} ${result.scannedCount}; no candidates found from the enabled providers`,
      );
    } catch (scanError) {
      setMessage(scanError instanceof Error ? scanError.message : String(scanError));
      setScanProgress(null);
    } finally {
      setBusy(false);
    }
  }, [t]);

  const mutateCandidate = useCallback(
    async (candidateId: string, action: 'missing' | 'selected' | 'reject'): Promise<void> => {
      try {
        const library = getLibraryBridge();

        if (!library) {
          setMessage('Desktop bridge unavailable. Open ECHO Next in Electron to repair metadata.');
          return;
        }

        const scanItem = scanItems.find((item) =>
          item.candidates.metadata.some((candidate) => candidate.id === candidateId) ||
          item.candidates.covers.some((candidate) => candidate.id === candidateId),
        );
        const result =
          action === 'missing'
            ? await library.applyNetworkMissingOnly(candidateId)
            : action === 'selected'
              ? await library.applyNetworkSelected(candidateId)
              : await library.rejectNetworkCandidate(candidateId);
        const appliedKeys = Object.keys(result.appliedFields);
        const feedback =
          action === 'reject'
            ? { tone: 'info' as const, text: '已拒绝这个候选。' }
            : appliedKeys.length
              ? {
                  tone: 'success' as const,
                  text: `已应用：${appliedKeys.map((key) => fieldLabels[key] ?? key).join('、')}`,
                }
              : { tone: 'warning' as const, text: resultReasonText(result.reason) };
        setCandidateFeedback((current) => ({ ...current, [candidateId]: feedback }));
        setMessage(
          appliedKeys.length
            ? feedback.text
            : `${result.status}: ${feedback.text}`,
        );
        if (appliedKeys.length) {
          window.dispatchEvent(new Event('library:changed'));
        }

        if (scanItem) {
          const nextCandidates = await library.showNetworkCandidates(scanItem.track.id);
          const nextTrack = await findTrackByExactId(scanItem.track.id);
          setScanItems((items) =>
            items.map((item) =>
              item.track.id === scanItem.track.id
                ? { ...item, track: nextTrack ?? item.track, candidates: nextCandidates }
                : item,
            ),
          );
          return;
        }

        const refreshedTrack = track ? await findTrackByExactId(track.id) : null;
        if (refreshedTrack) {
          setTrack(refreshedTrack);
          setCandidates(await library.showNetworkCandidates(refreshedTrack.id));
        } else {
          await refreshCandidates();
        }
      } catch (mutationError) {
        setMessage(mutationError instanceof Error ? mutationError.message : String(mutationError));
      }
    },
    [findTrackByExactId, refreshCandidates, scanItems, track],
  );

  const repairScanItem = useCallback(
    async (item: MissingMetadataScanItem): Promise<void> => {
      setBusy(true);

      try {
        const library = getLibraryBridge();

        if (!library) {
          setMessage('Desktop bridge unavailable. Open ECHO Next in Electron to repair metadata.');
          return;
        }

        const result = await library.repairMissingMetadata(item.track.id);
        const nextTrack = await findTrackByExactId(item.track.id);
        setScanItems((items) =>
          items.map((scanItem) =>
            scanItem.track.id === item.track.id
              ? { ...scanItem, track: nextTrack ?? scanItem.track, candidates: { metadata: result.metadata, covers: result.covers } }
              : scanItem,
          ),
        );
        setMessage(result.errors.length ? result.errors.join(', ') : `${t('settings.library.networkPanel.appliedCount')} ${result.applied.length}`);
      } catch (repairError) {
        setMessage(repairError instanceof Error ? repairError.message : String(repairError));
      } finally {
        setBusy(false);
      }
    },
    [findTrackByExactId, t],
  );

  const applyAllScanCandidates = useCallback(async (): Promise<void> => {
    const library = getLibraryBridge();

    if (!library) {
      setMessage('Desktop bridge unavailable. Open ECHO Next in Electron to repair metadata.');
      return;
    }

    const candidateIds = scanItems
      .map((item) => item.candidates.metadata[0]?.id)
      .filter((candidateId): candidateId is string => Boolean(candidateId));

    if (!candidateIds.length) {
      setMessage('没有可应用的网络候选。先扫描缺失元数据，或调整网络来源后再试。');
      return;
    }

    setBusy(true);
    setBulkApplying(true);
    setCandidateFeedback({});
    setScanProgress({ label: '正在批量补全', percent: 5 });

    let appliedCount = 0;
    let skippedCount = 0;
    const feedback: Record<string, { tone: 'success' | 'info' | 'warning'; text: string }> = {};

    try {
      for (let index = 0; index < candidateIds.length; index += 1) {
        const candidateId = candidateIds[index];
        const result = await library.applyNetworkSelected(candidateId);
        const appliedKeys = Object.keys(result.appliedFields);

        if (appliedKeys.length) {
          appliedCount += 1;
          feedback[candidateId] = {
            tone: 'success',
            text: `已应用：${appliedKeys.map((key) => fieldLabels[key] ?? key).join('、')}`,
          };
        } else {
          skippedCount += 1;
          feedback[candidateId] = { tone: 'warning', text: resultReasonText(result.reason) };
        }

        setScanProgress({
          label: '正在批量补全',
          percent: Math.max(5, Math.round(((index + 1) / candidateIds.length) * 100)),
        });
      }

      setCandidateFeedback(feedback);
      setMessage(`批量补全完成：已应用 ${appliedCount} 首，跳过 ${skippedCount} 首。`);
      if (appliedCount > 0) {
        window.dispatchEvent(new Event('library:changed'));
      }

      const refreshedItems = await Promise.all(
        scanItems.map(async (item) => {
          const [nextTrack, nextCandidates] = await Promise.all([
            findTrackByExactId(item.track.id),
            library.showNetworkCandidates(item.track.id),
          ]);
          return { ...item, track: nextTrack ?? item.track, candidates: nextCandidates };
        }),
      );
      setScanItems(refreshedItems);
      setScanProgress({ label: '批量补全完成', percent: 100 });
    } catch (applyError) {
      setMessage(applyError instanceof Error ? applyError.message : String(applyError));
      setScanProgress(null);
    } finally {
      setBulkApplying(false);
      setBusy(false);
    }
  }, [findTrackByExactId, scanItems]);

  return (
    <section className="audio-dev-panel network-metadata-panel" aria-label={t('settings.library.networkPanel.title')}>
      <div className="audio-dev-header">
        <div>
          <span className="panel-kicker">{t('settings.library.networkPanel.kicker')}</span>
          <h2>{t('settings.library.networkPanel.title')}</h2>
        </div>
        <button
          className="tool-button"
          type="button"
          aria-label={t('settings.library.networkPanel.showCandidates')}
          title={t('settings.library.networkPanel.showCandidates')}
          onClick={() => void refreshCandidates()}
        >
          <RefreshCw size={17} />
        </button>
      </div>

      <label className="settings-search">
        <Search size={15} aria-hidden="true" />
        <input
          value={trackId}
          onChange={(event) => setTrackId(event.target.value)}
          placeholder={`${t('settings.library.networkPanel.trackId')} / title / artist`}
        />
      </label>

      <div className="settings-chip-row">
        <button className="settings-action-button" type="button" disabled={busy} onClick={() => void scanMissing()}>
          <Wand2 size={15} />
          {busy ? '扫描中...' : t('settings.library.networkPanel.scanMissing')}
        </button>
        <button
          className="settings-action-button"
          type="button"
          disabled={busy || !scanItems.some((item) => item.candidates.metadata.length > 0)}
          onClick={() => void applyAllScanCandidates()}
        >
          <Wand2 size={15} />
          {bulkApplying ? '补全中...' : '一键全部补全'}
        </button>
        <button className="settings-action-button" type="button" disabled={busy} onClick={() => void repair()}>
          {t('settings.library.networkPanel.repairMissing')}
        </button>
        <button className="settings-action-button" type="button" disabled={busy} onClick={() => void refreshCandidates()}>
          {t('settings.library.networkPanel.showCandidates')}
        </button>
      </div>

      {scanProgress ? (
        <div className="network-scan-progress" role="status" aria-live="polite">
          <div className="network-scan-progress-label">
            <span>{scanProgress.label}</span>
            <strong>{Math.round(scanProgress.percent)}%</strong>
          </div>
          <div
            className="network-scan-progress-track"
            aria-label={t('settings.library.networkPanel.scanProgress')}
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={Math.round(scanProgress.percent)}
            role="progressbar"
          >
            <span style={{ width: `${scanProgress.percent}%` }} />
          </div>
        </div>
      ) : null}

      {message ? <p className="settings-inline-note network-panel-message">{message}</p> : null}

      {track ? (
        <div className="settings-status-grid">
          <span>
            <em>{t('settings.library.networkPanel.titleField')}</em>
            <strong>{track.title}</strong>
          </span>
          <span>
            <em>{t('settings.library.networkPanel.artistField')}</em>
            <strong>{track.artist}</strong>
          </span>
          <span>
            <em>{t('settings.library.networkPanel.embeddedMetadata')}</em>
            <strong>{track.embeddedMetadataStatus}</strong>
          </span>
          <span>
            <em>{t('settings.library.networkPanel.embeddedCover')}</em>
            <strong>{track.embeddedCoverStatus}</strong>
          </span>
        </div>
      ) : null}

      {candidates.metadata.map((candidate) =>
        track ? (
          <NetworkCandidateCard
            candidate={candidate}
            feedback={candidateFeedback[candidate.id]}
            key={candidate.id}
            track={track}
            onApplyMissingOnly={(id) => void mutateCandidate(id, 'missing')}
            onApplySelected={(id) => void mutateCandidate(id, 'selected')}
            onReject={(id) => void mutateCandidate(id, 'reject')}
          />
        ) : null,
      )}

      {scanItems.length ? (
        <div className="network-missing-list">
          {scanItems.map((item) => (
            <article className="network-missing-item" key={item.track.id}>
              <header>
                <div>
                  <strong>{item.track.title || t('settings.library.networkPanel.untitled')}</strong>
                  <span>{item.track.artist || t('settings.library.networkPanel.unknownArtist')}</span>
                </div>
                <div className="network-missing-actions">
                  <em>{item.reasons.join(', ')}</em>
                  <button className="settings-action-button" type="button" disabled={busy} onClick={() => void repairScanItem(item)}>
                    {t('settings.library.networkPanel.repairThisTrack')}
                  </button>
                </div>
              </header>
              <div className="settings-status-grid">
                <span>
                  <em>{t('settings.library.networkPanel.cover')}</em>
                  <strong>{item.track.coverId ? t('settings.library.networkPanel.localCover') : t('settings.library.networkPanel.missingCover')}</strong>
                </span>
                <span>
                  <em>{t('settings.library.networkPanel.artistSource')}</em>
                  <strong>{item.track.fieldSources.artist ?? 'unknown'}</strong>
                </span>
                <span>
                  <em>{t('settings.library.networkPanel.embeddedMetadata')}</em>
                  <strong>{item.track.embeddedMetadataStatus ?? 'pending'}</strong>
                </span>
                <span>
                  <em>{t('settings.library.networkPanel.candidates')}</em>
                  <strong>{item.candidates.metadata.length + item.candidates.covers.length}</strong>
                </span>
              </div>
              {item.candidates.metadata.length ? (
                item.candidates.metadata.map((candidate) => (
                  <NetworkCandidateCard
                    candidate={candidate}
                    feedback={candidateFeedback[candidate.id]}
                    key={candidate.id}
                    track={item.track}
                    onApplyMissingOnly={(id) => void mutateCandidate(id, 'missing')}
                    onApplySelected={(id) => void mutateCandidate(id, 'selected')}
                    onReject={(id) => void mutateCandidate(id, 'reject')}
                  />
                ))
              ) : (
                <p className="settings-inline-note">{t('settings.library.networkPanel.noCandidates')}</p>
              )}
            </article>
          ))}
        </div>
      ) : null}

    </section>
  );
};
