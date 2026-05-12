import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, CloudDownload, ImagePlus, RefreshCw, Save, Tag, X } from 'lucide-react';
import type { EditableTrackTags, LibraryTrack, NetworkTagCandidate, TrackCoverSelection } from '../../../shared/types/library';

type TrackTagEditorDrawerProps = {
  track: LibraryTrack | null;
  isOpen: boolean;
  isSaving: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (track: LibraryTrack, tags: EditableTrackTags, coverPath: string | null, coverUrl: string | null, coverMimeType: string | null) => void;
};

type TagFormState = {
  title: string;
  artist: string;
  album: string;
  albumArtist: string;
  trackNo: string;
  discNo: string;
  year: string;
  genre: string;
};

type PendingNetworkCover = {
  url: string;
  mimeType: string | null;
  previewUrl: string;
};

type NetworkFieldSelection = Record<keyof TagFormState | 'cover', boolean>;

const networkFieldLabels: Array<{ key: keyof TagFormState | 'cover'; label: string }> = [
  { key: 'title', label: '标题' },
  { key: 'artist', label: '艺术家' },
  { key: 'album', label: '专辑' },
  { key: 'albumArtist', label: '专辑艺术家' },
  { key: 'trackNo', label: '音轨号' },
  { key: 'discNo', label: '碟号' },
  { key: 'year', label: '年份' },
  { key: 'genre', label: '流派' },
  { key: 'cover', label: '封面' },
];

const emptyNetworkSelection = (): NetworkFieldSelection => ({
  title: false,
  artist: false,
  album: false,
  albumArtist: false,
  trackNo: false,
  discNo: false,
  year: false,
  genre: false,
  cover: false,
});

const allNetworkFieldsSelected = (selection: NetworkFieldSelection): boolean => networkFieldLabels.every((field) => selection[field.key]);
const someNetworkFieldsSelected = (selection: NetworkFieldSelection): boolean => networkFieldLabels.some((field) => selection[field.key]);

const stateFromTrack = (track: LibraryTrack | null): TagFormState => ({
  title: track?.title ?? '',
  artist: track?.artist ?? '',
  album: track?.album ?? '',
  albumArtist: track?.albumArtist ?? '',
  trackNo: track?.trackNo ? String(track.trackNo) : '',
  discNo: track?.discNo ? String(track.discNo) : '',
  year: track?.year ? String(track.year) : '',
  genre: track?.genre ?? '',
});

const numberOrNull = (value: string): number | null => {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
};

const hasFormValue = (value: string): boolean => value.trim().length > 0;
const hasCandidateText = (value: string | null | undefined): boolean => (value ?? '').trim().length > 0;
const candidateNumberText = (value: number | null | undefined): string => (typeof value === 'number' && Number.isFinite(value) ? String(value) : '');
const formatDuration = (seconds: number | null | undefined): string => {
  if (!seconds || !Number.isFinite(seconds)) {
    return '未知时长';
  }

  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
};

export const defaultNetworkFieldSelection = (
  form: TagFormState,
  track: Pick<LibraryTrack, 'coverThumb'>,
  candidate: NetworkTagCandidate,
): NetworkFieldSelection => {
  const highConfidence = candidate.confidence >= 0.93;
  return {
    title: hasCandidateText(candidate.title) && (!hasFormValue(form.title) || highConfidence),
    artist: hasCandidateText(candidate.artist) && (!hasFormValue(form.artist) || highConfidence),
    album: hasCandidateText(candidate.album) && (!hasFormValue(form.album) || highConfidence),
    albumArtist: hasCandidateText(candidate.albumArtist) && (!hasFormValue(form.albumArtist) || highConfidence),
    trackNo: candidate.trackNo !== null && (!hasFormValue(form.trackNo) || highConfidence),
    discNo: candidate.discNo !== null && (!hasFormValue(form.discNo) || highConfidence),
    year: candidate.year !== null && (!hasFormValue(form.year) || highConfidence),
    genre: hasCandidateText(candidate.genre) && (!hasFormValue(form.genre) || highConfidence),
    cover: Boolean(candidate.coverUrl) && (!track.coverThumb || highConfidence),
  };
};

export const applyNetworkCandidateToForm = (
  form: TagFormState,
  candidate: NetworkTagCandidate,
  fields: NetworkFieldSelection,
): TagFormState => ({
  ...form,
  title: fields.title && hasCandidateText(candidate.title) ? candidate.title : form.title,
  artist: fields.artist && hasCandidateText(candidate.artist) ? candidate.artist : form.artist,
  album: fields.album && hasCandidateText(candidate.album) ? candidate.album : form.album,
  albumArtist: fields.albumArtist && hasCandidateText(candidate.albumArtist) ? candidate.albumArtist : form.albumArtist,
  trackNo: fields.trackNo ? candidateNumberText(candidate.trackNo) : form.trackNo,
  discNo: fields.discNo ? candidateNumberText(candidate.discNo) : form.discNo,
  year: fields.year ? candidateNumberText(candidate.year) : form.year,
  genre: fields.genre && candidate.genre ? candidate.genre : form.genre,
});

export const TrackTagEditorDrawer = ({ track, isOpen, isSaving, error, onClose, onSave }: TrackTagEditorDrawerProps): JSX.Element | null => {
  const [form, setForm] = useState<TagFormState>(() => stateFromTrack(track));
  const [selectedCover, setSelectedCover] = useState<TrackCoverSelection | null>(null);
  const [pendingNetworkCover, setPendingNetworkCover] = useState<PendingNetworkCover | null>(null);
  const [loadedCoverThumb, setLoadedCoverThumb] = useState<string | null>(null);
  const [isLoadingEmbedded, setIsLoadingEmbedded] = useState(false);
  const [isSearchingNetwork, setIsSearchingNetwork] = useState(false);
  const [networkCandidates, setNetworkCandidates] = useState<NetworkTagCandidate[]>([]);
  const [selectedNetworkCandidate, setSelectedNetworkCandidate] = useState<NetworkTagCandidate | null>(null);
  const [networkFieldSelection, setNetworkFieldSelection] = useState<NetworkFieldSelection>(() => emptyNetworkSelection());
  const [networkMessage, setNetworkMessage] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const fileName = useMemo(() => track?.path.split(/[\\/]/).pop() ?? '', [track?.path]);
  const previewCover = selectedCover?.dataUrl ?? pendingNetworkCover?.previewUrl ?? loadedCoverThumb ?? track?.coverThumb ?? null;

  useEffect(() => {
    if (track) {
      setForm(stateFromTrack(track));
      setSelectedCover(null);
      setPendingNetworkCover(null);
      setLoadedCoverThumb(null);
      setNetworkCandidates([]);
      setSelectedNetworkCandidate(null);
      setNetworkFieldSelection(emptyNetworkSelection());
      setNetworkMessage(null);
      setLocalError(null);
    }
  }, [track]);

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!track) {
    return null;
  }

  const updateField = (field: keyof TagFormState, value: string): void => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  const handleSubmit = (event: FormEvent): void => {
    event.preventDefault();
    onSave(
      track,
      {
        title: form.title,
        artist: form.artist,
        album: form.album,
        albumArtist: form.albumArtist,
        trackNo: numberOrNull(form.trackNo),
        discNo: numberOrNull(form.discNo),
        year: numberOrNull(form.year),
        genre: form.genre.trim() || null,
      },
      selectedCover?.path ?? null,
      selectedCover ? null : (pendingNetworkCover?.url ?? null),
      selectedCover ? null : (pendingNetworkCover?.mimeType ?? null),
    );
  };

  const handleChooseCover = async (): Promise<void> => {
    const library = window.echo?.library;

    if (!library?.chooseTrackCover) {
      setLocalError('当前运行环境不支持选择封面。');
      return;
    }

    try {
      setLocalError(null);
      const selection = await library.chooseTrackCover();
      if (selection) {
        setSelectedCover(selection);
        setPendingNetworkCover(null);
        setLoadedCoverThumb(null);
      }
    } catch (chooseError) {
      setLocalError(chooseError instanceof Error ? chooseError.message : String(chooseError));
    }
  };

  const handleLoadEmbedded = async (): Promise<void> => {
    const library = window.echo?.library;

    if (!library?.loadEmbeddedTrackTags) {
      setLocalError('当前运行环境不支持读取内嵌标签。');
      return;
    }

    setIsLoadingEmbedded(true);
    setLocalError(null);

    try {
      const result = await library.loadEmbeddedTrackTags(track.id);
      setForm({
        title: result.tags.title,
        artist: result.tags.artist,
        album: result.tags.album,
        albumArtist: result.tags.albumArtist,
        trackNo: result.tags.trackNo ? String(result.tags.trackNo) : '',
        discNo: result.tags.discNo ? String(result.tags.discNo) : '',
        year: result.tags.year ? String(result.tags.year) : '',
        genre: result.tags.genre ?? '',
      });
      setSelectedCover(null);
      setPendingNetworkCover(null);
      setLoadedCoverThumb(result.coverThumb);
    } catch (loadError) {
      setLocalError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setIsLoadingEmbedded(false);
    }
  };

  const handleSearchNetwork = async (): Promise<void> => {
    const library = window.echo?.library;

    if (!library?.searchNetworkTagCandidates) {
      setLocalError('当前运行环境不支持网络标签搜索。');
      return;
    }

    setIsSearchingNetwork(true);
    setLocalError(null);
    setNetworkMessage('正在搜索网络标签...');
    setSelectedNetworkCandidate(null);
    setNetworkFieldSelection(emptyNetworkSelection());

    try {
      const candidates = await library.searchNetworkTagCandidates(track.id);
      setNetworkCandidates(candidates);
      setNetworkMessage(candidates.length ? null : '没有找到合适的网络标签。');
    } catch (searchError) {
      setNetworkCandidates([]);
      setNetworkMessage(null);
      setLocalError(searchError instanceof Error ? searchError.message : '网络来源暂时不可用，请稍后再试。');
    } finally {
      setIsSearchingNetwork(false);
    }
  };

  const handleSelectNetworkCandidate = (candidate: NetworkTagCandidate): void => {
    setSelectedNetworkCandidate(candidate);
    setNetworkFieldSelection(defaultNetworkFieldSelection(form, track, candidate));
  };

  const handleToggleNetworkField = (field: keyof NetworkFieldSelection): void => {
    setNetworkFieldSelection((current) => ({ ...current, [field]: !current[field] }));
  };

  const handleToggleAllNetworkFields = (): void => {
    setNetworkFieldSelection((current) => {
      const nextChecked = !allNetworkFieldsSelected(current);
      return networkFieldLabels.reduce(
        (next, field) => ({
          ...next,
          [field.key]: nextChecked,
        }),
        emptyNetworkSelection(),
      );
    });
  };

  const handleApplyNetworkCandidate = (): void => {
    if (!selectedNetworkCandidate) {
      return;
    }

    setForm((current) => applyNetworkCandidateToForm(current, selectedNetworkCandidate, networkFieldSelection));

    if (networkFieldSelection.cover && selectedNetworkCandidate.coverUrl) {
      setPendingNetworkCover({
        url: selectedNetworkCandidate.coverUrl,
        mimeType: selectedNetworkCandidate.coverMimeType ?? null,
        previewUrl: selectedNetworkCandidate.coverPreviewUrl ?? selectedNetworkCandidate.coverUrl,
      });
      setSelectedCover(null);
      setLoadedCoverThumb(null);
    }

    setNetworkMessage('已应用到表单，点击保存后才会写入文件和媒体库。');
  };

  const editor = (
    <div className="tag-editor-root" data-open={isOpen}>
      <button className="tag-editor-scrim" type="button" aria-label="关闭编辑标签" onClick={onClose} />
      <form className="tag-editor-drawer" onSubmit={handleSubmit}>
        <header className="tag-editor-header">
          <div>
            <Tag size={24} />
            <h2>编辑标签</h2>
          </div>
          <button className="tag-editor-close" type="button" aria-label="关闭编辑标签" onClick={onClose}>
            <X size={24} />
          </button>
        </header>

        <section className="tag-editor-cover-card">
          <div className="tag-editor-cover" data-empty={!previewCover}>
            {previewCover ? <img alt="" src={previewCover} /> : <Tag size={42} />}
          </div>
          <div className="tag-editor-file">
            <strong>{fileName}</strong>
            <span>{track.path}</span>
            <button type="button" onClick={() => void handleChooseCover()} disabled={isSaving || isLoadingEmbedded || isSearchingNetwork}>
              <ImagePlus size={18} />
              选择封面
            </button>
            <small>{selectedCover ? selectedCover.path : pendingNetworkCover ? '保存时会下载并应用网络封面。' : '留空会保留当前内嵌封面。'}</small>
            <button type="button" onClick={() => void handleLoadEmbedded()} disabled={isSaving || isLoadingEmbedded || isSearchingNetwork}>
              <RefreshCw size={18} />
              {isLoadingEmbedded ? '读取中' : '从内嵌标签加载'}
            </button>
            <button type="button" onClick={() => void handleSearchNetwork()} disabled={isSaving || isLoadingEmbedded || isSearchingNetwork}>
              <CloudDownload size={18} />
              {isSearchingNetwork ? '搜索中' : '从网络加载'}
            </button>
          </div>
        </section>

        {networkMessage ? <p className="tag-editor-network-message">{networkMessage}</p> : null}

        {networkCandidates.length ? (
          <section className="tag-editor-network-panel" aria-label="网络标签候选">
            <div className="tag-editor-network-list">
              {networkCandidates.map((candidate) => (
                <button
                  key={candidate.id}
                  className="tag-editor-network-candidate"
                  type="button"
                  data-selected={selectedNetworkCandidate?.id === candidate.id}
                  onClick={() => handleSelectNetworkCandidate(candidate)}
                >
                  <span className="tag-editor-network-cover" data-empty={!candidate.coverPreviewUrl}>
                    {candidate.coverPreviewUrl ? <img alt="" src={candidate.coverPreviewUrl} /> : <Tag size={24} />}
                  </span>
                  <span className="tag-editor-network-copy">
                    <strong>{candidate.title || '未知标题'}</strong>
                    <em>{candidate.artist || '未知艺术家'}</em>
                    <small>
                      {[candidate.album, candidate.albumArtist, candidate.year, formatDuration(candidate.duration)].filter(Boolean).join(' · ')}
                    </small>
                  </span>
                  <span className="tag-editor-network-score">
                    <b>{candidate.provider}</b>
                    <em>{Math.round(candidate.confidence * 100)}%</em>
                  </span>
                </button>
              ))}
            </div>

            {selectedNetworkCandidate ? (
              <div className="tag-editor-network-fields">
                <div className="tag-editor-network-fields-header">
                  <span>选择要应用到表单的字段</span>
                  <label>
                    <input
                      ref={(node) => {
                        if (node) {
                          node.indeterminate = someNetworkFieldsSelected(networkFieldSelection) && !allNetworkFieldsSelected(networkFieldSelection);
                        }
                      }}
                      type="checkbox"
                      checked={allNetworkFieldsSelected(networkFieldSelection)}
                      onChange={handleToggleAllNetworkFields}
                    />
                    <span>全选</span>
                  </label>
                </div>
                <div>
                  {networkFieldLabels.map((field) => (
                    <label key={field.key}>
                      <input
                        type="checkbox"
                        checked={networkFieldSelection[field.key]}
                        onChange={() => handleToggleNetworkField(field.key)}
                      />
                      <span>{field.label}</span>
                    </label>
                  ))}
                </div>
                <button type="button" onClick={handleApplyNetworkCandidate} disabled={isSaving}>
                  <Check size={17} />
                  应用到表单
                </button>
              </div>
            ) : null}
          </section>
        ) : null}

        <div className="tag-editor-grid">
          <label>
            <span>标题</span>
            <input value={form.title} onChange={(event) => updateField('title', event.target.value)} />
          </label>
          <label>
            <span>艺术家</span>
            <input value={form.artist} onChange={(event) => updateField('artist', event.target.value)} />
          </label>
          <label>
            <span>专辑</span>
            <input value={form.album} onChange={(event) => updateField('album', event.target.value)} />
          </label>
          <label>
            <span>专辑艺术家</span>
            <input value={form.albumArtist} onChange={(event) => updateField('albumArtist', event.target.value)} />
          </label>
          <label>
            <span>音轨号</span>
            <input inputMode="numeric" value={form.trackNo} onChange={(event) => updateField('trackNo', event.target.value)} />
          </label>
          <label>
            <span>碟号</span>
            <input inputMode="numeric" value={form.discNo} onChange={(event) => updateField('discNo', event.target.value)} />
          </label>
          <label>
            <span>年份</span>
            <input inputMode="numeric" value={form.year} onChange={(event) => updateField('year', event.target.value)} />
          </label>
          <label className="tag-editor-wide">
            <span>流派</span>
            <input value={form.genre} onChange={(event) => updateField('genre', event.target.value)} />
          </label>
        </div>

        {error || localError ? <p className="tag-editor-error">{error ?? localError}</p> : null}

        <footer className="tag-editor-actions">
          <span>更改会写入源音频文件，并立即反映到媒体库。</span>
          <button className="tag-editor-cancel" type="button" onClick={onClose}>
            取消
          </button>
          <button className="tag-editor-save" type="submit" disabled={isSaving}>
            <Save size={18} />
            {isSaving ? '保存中' : '保存标签'}
          </button>
        </footer>
      </form>
    </div>
  );

  return createPortal(editor, document.body);
};
