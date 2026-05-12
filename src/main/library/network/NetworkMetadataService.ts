import type { EchoDatabase } from '../../database/createDatabase';
import type { MissingMetadataScanResult, NetworkTagCandidate, NetworkTagCandidateSearchRequest } from '../../../shared/types/library';
import type { NetworkMetadataProvider } from './NetworkMetadataProvider';
import { NetworkMetadataJobQueue } from './NetworkMetadataJobQueue';
import { NetworkMetadataMerge } from './NetworkMetadataMerge';
import { NetworkMetadataStore } from './NetworkMetadataStore';
import { matchScore } from './matchScore';
import type { NetworkApplyResult, NetworkProviderName, StoredNetworkCoverCandidate, StoredNetworkMetadataCandidate } from './networkTypes';
import { CoverArtArchiveProvider } from './providers/CoverArtArchiveProvider';
import { MockMetadataProvider } from './providers/MockMetadataProvider';
import { MusicBrainzProvider } from './providers/MusicBrainzProvider';
import { NeteaseCloudMusicProvider } from './providers/NeteaseCloudMusicProvider';
import { QQMusicProvider } from './providers/QQMusicProvider';

export type NetworkCandidateList = {
  metadata: StoredNetworkMetadataCandidate[];
  covers: StoredNetworkCoverCandidate[];
};

export type NetworkRepairResult = NetworkCandidateList & {
  applied: NetworkApplyResult[];
  errors: string[];
};

const NETWORK_TAG_EDITOR_VISIBLE_THRESHOLD = 0.45;

const runWithConcurrency = async (tasks: Array<() => Promise<void>>, concurrency: number): Promise<void> => {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length)) }, async () => {
    while (nextIndex < tasks.length) {
      const task = tasks[nextIndex];
      nextIndex += 1;
      await task();
    }
  });

  await Promise.all(workers);
};

export class NetworkMetadataService {
  private readonly store: NetworkMetadataStore;
  private readonly merge: NetworkMetadataMerge;
  private readonly queue = new NetworkMetadataJobQueue(2);
  private readonly providers: NetworkMetadataProvider[];

  constructor(
    private readonly database: EchoDatabase,
    providers: NetworkMetadataProvider[] = [
      new MockMetadataProvider(),
      new NeteaseCloudMusicProvider(),
      new QQMusicProvider(),
      new MusicBrainzProvider(),
      new CoverArtArchiveProvider(),
    ],
  ) {
    this.store = new NetworkMetadataStore(database);
    this.merge = new NetworkMetadataMerge(database);
    this.providers = providers;
  }

  async repairMissingMetadata(trackId: string, providerNames?: NetworkProviderName[]): Promise<NetworkRepairResult> {
    return this.queue.run(async () => {
      const track = this.store.getTrackLookup(trackId);
      const applied: NetworkApplyResult[] = [];
      const errors: string[] = [];

      if (!track) {
        return { metadata: [], covers: [], applied, errors: [`Unknown track ${trackId}`] };
      }

      const providers = this.providers.filter((provider) => !providerNames?.length || providerNames.includes(provider.name));
      this.database.prepare("UPDATE tracks SET network_metadata_status = 'pending', updated_at = ? WHERE id = ?").run(new Date().toISOString(), trackId);

      for (const provider of providers) {
        try {
          const candidates = await provider.findMetadata(track);
          for (const candidate of candidates) {
            const score = matchScore(track, candidate);
            if (score < NETWORK_TAG_EDITOR_VISIBLE_THRESHOLD) {
              continue;
            }

            const stored = this.store.upsertMetadataCandidate(trackId, null, candidate, score);
            const result = this.merge.applyMissingOnly(stored.id);
            if (result.status === 'applied_missing_only') {
              applied.push(result);
            }
          }
        } catch (error) {
          errors.push(`${provider.name}: ${error instanceof Error ? error.message : String(error)}`);
          this.database.prepare("UPDATE tracks SET network_metadata_status = 'error', updated_at = ? WHERE id = ?").run(new Date().toISOString(), trackId);
        }
      }

      return {
        metadata: this.store.listTrackMetadataCandidates(trackId),
        covers: this.store.listTrackCoverCandidates(trackId),
        applied,
        errors,
      };
    });
  }

  async scanMissingMetadata(limit = 25, providerNames?: NetworkProviderName[]): Promise<MissingMetadataScanResult> {
    return this.queue.run(async () => {
      const targets = this.store.findMissingMetadataTargets(limit);
      const providers = this.providers.filter((provider) => !providerNames?.length || providerNames.includes(provider.name));
      const errors: string[] = [];
      const tasks = targets.flatMap((target) => {
        if (target.embeddedMetadataStatus === 'pending' || target.embeddedMetadataStatus === 'reading') {
          return [];
        }

        return providers.map((provider) => async () => {
          try {
            const candidates = await provider.findMetadata(target);
            for (const candidate of candidates) {
              const score = matchScore(target, candidate);
              const missingArtistCandidate = target.reasons.includes('unknown_artist') && Boolean(candidate.artist);
              const missingCoverCandidate = target.reasons.includes('missing_cover') && Boolean(candidate.coverUrl);
              if (score >= NETWORK_TAG_EDITOR_VISIBLE_THRESHOLD || missingCoverCandidate || (missingArtistCandidate && score >= 0.6)) {
                this.store.upsertMetadataCandidate(target.trackId, null, candidate, score);
              }
            }
          } catch (error) {
            errors.push(`${target.track.title || target.track.path}: ${provider.name}: ${error instanceof Error ? error.message : String(error)}`);
          }
        });
      });

      await runWithConcurrency(tasks, 2);

      const items = targets.map((target) => ({
        track: target.track,
        reasons: target.reasons,
        candidates: this.showCandidates(target.trackId),
      }));

      return {
        items,
        scannedCount: targets.length,
        candidateCount: items.reduce((total, item) => total + item.candidates.metadata.length + item.candidates.covers.length, 0),
        errors,
      };
    });
  }

  showCandidates(trackId: string): NetworkCandidateList {
    return {
      metadata: this.store.listTrackMetadataCandidates(trackId),
      covers: this.store.listTrackCoverCandidates(trackId),
    };
  }

  async searchNetworkTagCandidates(request: NetworkTagCandidateSearchRequest): Promise<NetworkTagCandidate[]> {
    return this.queue.run(async () => {
      const track = this.store.getTrackLookup(request.trackId);
      const errors: string[] = [];

      if (!track) {
        throw new Error(`Unknown track ${request.trackId}`);
      }

      const searchTrack = request.query?.trim()
        ? {
            ...track,
            title: request.query.trim(),
            artist: '',
            filename: request.query.trim(),
          }
        : track;
      const providers = this.providers.filter((provider) => !request.providers?.length || request.providers.includes(provider.name));

      if (!providers.length) {
        throw new Error('Network metadata provider is unavailable');
      }

      for (const provider of providers) {
        try {
          const metadataCandidates = await provider.findMetadata(searchTrack);
          for (const candidate of metadataCandidates) {
            const score = matchScore(track, candidate);
            if (score >= NETWORK_TAG_EDITOR_VISIBLE_THRESHOLD) {
              this.store.upsertMetadataCandidate(track.trackId, null, candidate, score);
            }
          }

          if (provider.findCovers) {
            const coverCandidates = await provider.findCovers(searchTrack);
            for (const cover of coverCandidates) {
              this.store.upsertCoverCandidate(track.trackId, null, cover);
            }
          }
        } catch (error) {
          errors.push(`${provider.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      const candidates = this.store
        .listTrackMetadataCandidates(track.trackId)
        .map(
          (candidate): NetworkTagCandidate => ({
            id: candidate.id,
            provider: candidate.provider,
            confidence: candidate.score,
            title: candidate.title ?? '',
            artist: candidate.artist ?? '',
            album: candidate.album ?? '',
            albumArtist: candidate.albumArtist ?? '',
            trackNo: candidate.trackNo,
            discNo: candidate.discNo,
            year: candidate.year,
            genre: candidate.genre,
            duration: candidate.duration,
            coverUrl: candidate.coverUrl,
            coverMimeType: null,
            coverPreviewUrl: candidate.coverUrl,
            raw: candidate.raw,
          }),
        )
        .sort((left, right) => right.confidence - left.confidence);

      if (!candidates.length && errors.length) {
        throw new Error('网络来源暂时不可用，请稍后再试。');
      }

      return candidates;
    });
  }

  applyMissingOnly(candidateId: string): NetworkApplyResult {
    return this.merge.applyMissingOnly(candidateId);
  }

  applySelected(candidateId: string): NetworkApplyResult {
    return this.merge.applyMissingOnly(candidateId, true);
  }

  getMetadataCandidate(candidateId: string): StoredNetworkMetadataCandidate | null {
    return this.store.getMetadataCandidate(candidateId);
  }

  reject(candidateId: string): NetworkApplyResult {
    return this.merge.reject(candidateId);
  }
}
