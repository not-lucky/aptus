/**
 * Neutral model-usage counts mirroring the IR usage shape. Counts are finite
 * non-negative safe integers; an absent field is distinct from zero.
 */
export interface Usage {
  readonly input: number;
  readonly output: number;
  readonly total?: number;
  readonly cacheReadInput?: number;
  readonly cacheWriteInput?: number;
  readonly reasoningOutput?: number;
}
