import { Check, ShieldCheck, X } from 'lucide-react';
import type { LibraryTrack, NetworkMetadataCandidate } from '../../../shared/types/library';
import { useI18n } from '../../i18n/I18nProvider';

type Props = {
  candidate: NetworkMetadataCandidate;
  feedback?: {
    tone: 'success' | 'info' | 'warning';
    text: string;
  };
  track: LibraryTrack;
  onApplyMissingOnly: (candidateId: string) => void;
  onApplySelected: (candidateId: string) => void;
  onReject: (candidateId: string) => void;
};

const fieldPairs: Array<['title' | 'artist' | 'album' | 'albumArtist' | 'year' | 'genre' | 'trackNo' | 'discNo', string]> = [
  ['title', 'Title'],
  ['artist', 'Artist'],
  ['album', 'Album'],
  ['albumArtist', 'Album artist'],
  ['year', 'Year'],
  ['genre', 'Genre'],
  ['trackNo', 'Track'],
  ['discNo', 'Disc'],
];

const providerLabels: Record<string, string> = {
  mock: 'Mock',
  'netease-cloud-music': '网易云音乐',
  'qq-music': 'QQ 音乐',
  musicbrainz: 'MusicBrainz',
  'cover-art-archive': 'Cover Art Archive',
};

const valueText = (value: unknown): string => {
  if (value === null || value === undefined || value === '') {
    return 'missing';
  }

  return String(value);
};

export const NetworkCandidateCard = ({ candidate, feedback, track, onApplyMissingOnly, onApplySelected, onReject }: Props): JSX.Element => {
  const { t } = useI18n();
  const visibleFields = fieldPairs.filter(([key]) => candidate[key] !== null || track[key] !== null);
  const candidateCoverUrl = candidate.coverUrl;

  return (
    <article className="network-candidate-card">
      <header>
        <div>
          <strong>{candidate.title ?? track.title}</strong>
          <span>{providerLabels[candidate.provider] ?? candidate.provider}</span>
        </div>
        <em>{candidate.score.toFixed(3)}</em>
      </header>
      <div className="network-candidate-main">
        <div className="network-candidate-cover" data-empty={!candidateCoverUrl}>
          {candidateCoverUrl ? <img alt="" src={candidateCoverUrl} /> : <span>No cover</span>}
        </div>
        <div className="network-candidate-summary">
          <span>
            <em>Provider item</em>
            <strong>{candidate.providerItemId}</strong>
          </span>
          <span>
            <em>Cover URL</em>
            <strong>{candidateCoverUrl ?? 'missing'}</strong>
          </span>
          <span>
            <em>Current field sources</em>
            <strong>
              title:{track.fieldSources.title ?? 'unknown'} / artist:{track.fieldSources.artist ?? 'unknown'}
            </strong>
          </span>
        </div>
      </div>
      <div className="network-diff-grid">
        {visibleFields.map(([key, label]) => (
          <span key={key}>
            <em>{label}</em>
            <small>local: {valueText(track[key])}</small>
            <b>candidate: {valueText(candidate[key])}</b>
            <strong>source: {track.fieldSources[key] ?? 'unknown'}</strong>
          </span>
        ))}
      </div>
      <footer>
        <button type="button" className="settings-action-button" onClick={() => onApplyMissingOnly(candidate.id)}>
          <ShieldCheck size={15} />
          {t('settings.library.networkPanel.applyMissingOnly')}
        </button>
        <button type="button" className="settings-action-button" onClick={() => onApplySelected(candidate.id)}>
          <Check size={15} />
          {t('settings.library.networkPanel.applySelected')}
        </button>
        <button type="button" className="settings-danger-button" onClick={() => onReject(candidate.id)}>
          <X size={15} />
          {t('settings.library.networkPanel.reject')}
        </button>
      </footer>
      {feedback ? (
        <p className="network-candidate-feedback" data-tone={feedback.tone} role="status">
          {feedback.text}
        </p>
      ) : null}
    </article>
  );
};
