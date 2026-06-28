import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  scoreSnapshot,
  ScoreSnapshot,
  ScoreResult,
  ScoringParams,
  DEFAULT_SCORING_PARAMS,
} from './score';

/**
 * Thin NestJS wrapper around the pure scoreSnapshot() function.
 *
 * Its ONLY job is to read config-driven weights/bands once at construction and
 * pass them into the pure function. It performs no scoring logic itself — all the
 * math lives in score.ts so M5's backtest can call scoreSnapshot() directly with
 * the same params and replay history deterministically.
 */
@Injectable()
export class ScoringService {
  private readonly logger = new Logger(ScoringService.name);
  private readonly params: ScoringParams;

  constructor(private readonly config: ConfigService) {
    const weights = this.config.get<ScoringParams['weights']>('scoring.scoreWeights');
    const bands   = this.config.get<ScoringParams['bands']>('scoring.scoreBands');
    this.params = {
      weights: weights ?? DEFAULT_SCORING_PARAMS.weights,
      bands:   bands   ?? DEFAULT_SCORING_PARAMS.bands,
    };
    this.logger.log(
      `Scoring params (HYPOTHESIS): weights=${JSON.stringify(this.params.weights)} ` +
      `bands=${JSON.stringify(this.params.bands)}`,
    );
  }

  /** Pure, deterministic scoring using the configured params. */
  score(snapshot: ScoreSnapshot): ScoreResult {
    return scoreSnapshot(snapshot, this.params);
  }

  get scoringParams(): ScoringParams {
    return this.params;
  }
}
