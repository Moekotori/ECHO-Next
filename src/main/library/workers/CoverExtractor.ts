import type { CoverExtractOptions, CoverResult } from '../libraryTypes';

export interface CoverExtractor {
  extract(filePath: string, options: CoverExtractOptions): Promise<CoverResult>;
}
