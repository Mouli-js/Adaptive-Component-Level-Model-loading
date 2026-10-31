// Type definitions for adaptive-onnx-loader 0.1 — public API only.
// Lower-level building blocks (ChunkSession, WorkerChainRunner, ChunkStore, decide, …) are also
// exported from the package for experiments; see README "Advanced".

export type ProfileName = 'low' | 'mid' | 'high';
export type Precision = 'fp32' | 'int8' | 'mixedC2';

export interface Weights { m: number; t: number; l: number; n?: number }

export interface Overrides {
  /** Memory the page may use for the model, before the safety reserve (MiB). */
  allowanceMiB?: number;
  /** HARD constraint: minimum SST-2 validation accuracy of the chosen plan (0–1). */
  minAccuracy?: number;
  /** Fraction of the allowance kept unused (default 0.15). */
  reserveFraction?: number;
  /** Multiplier on measured Worker heaps (default 1.10). */
  heapUncertainty?: number;
  /** Typical sentences per infer() call; bounds the useful group size (default 1). */
  sentencesPerRequest?: number;
  deviceMemoryGiB?: number; cores?: number; downlinkMbps?: number; rttMs?: number;
  weights?: Weights;
}

export interface LoadOptions {
  /** URL of models/onnx/manifest.json (chunk files, vocab and early_exit.json are resolved relative to it). */
  manifestUrl: string;
  /** Simulated device profile; omit to use this browser's signals. */
  profile?: ProfileName | null;
  overrides?: Overrides;
  /** Allow early exit (changes predictions; still subject to minAccuracy). Default false. */
  earlyExit?: boolean;
  /** Measure this device's timings before deciding (~7 s; makes decisions non-deterministic). Default false. */
  calibrate?: boolean;
  /** Persistent IndexedDB chunk cache. Default true. */
  cache?: boolean;
  dbName?: string;
  /** Re-hash cached chunks on every read (SHA-256). Default true. */
  verifyOnRead?: boolean;
  /** Absolute URL of onnxruntime-web/dist/ort.wasm.min.mjs (import maps do not apply inside Workers).
   *  Default: /node_modules/onnxruntime-web/dist/ort.wasm.min.mjs on the page's origin. */
  ortUrl?: string;
  /** Directory of the ORT .wasm files. Default: the directory of ortUrl. */
  wasmPaths?: string;
  /** Override the bundled Worker script URL (bundlers). */
  workerUrl?: string;
  /** Refuse to run when the page is not cross-origin isolated. Default true. */
  requireIsolation?: boolean;
  threadsPerWorker?: number;
}

export interface Plan { id: string; precision: Precision; pinned: string[]; groupSize: number; prewarm: boolean; earlyExit: boolean }

export interface PredictedMetrics {
  id: string; cost: number; accuracy: number;
  terms: { m: number; t: number; l: number; n: number };
  memory: { peakMiB: number; workerWasmMiB: number; pageTensorsMiB: number; cachedBytesMiB: number; browserOverheadMiB: number; maxLiveWorkers: number };
  time: { perSentenceMs: number; computeMs: number; reloadPerSentenceMs: number; transferMs: number; initialLoadMs: number; startupsPerSentence: number; effectiveGroupSize: number };
  network: { firstRequestMiB: number; persistentCache: boolean; diskNeedMiB: number };
}

export interface PlanExplanation {
  planId: string; plan: Plan; profile: string;
  /** Human-readable reasons, one line per step. */
  explanation: string[];
  predicted: PredictedMetrics;
  budget: { allowanceMiB: number; reserveFraction: number; reserveMiB: number; usableMiB: number; diskUsableMiB: number };
  candidates: { total: number; feasible: number; rejected: { memory: number; accuracy: number; unverified: number } };
  calibration: string;
  runnersUp: string[];
  /** Whether early exit was requested / used, τ, and why it was or wasn't used. */
  earlyExit: { requested: boolean; used: boolean; tau: number | null; reason: string };
  /** Best plan per family (precision × mode × early exit) or the hard constraint that ruled it out. */
  alternatives: AlternativeFamily[];
  /** Signals used for the decision and the source of each value. */
  context: Record<string, unknown> & { sources: Record<string, string> };
  calibrationValues: Record<string, unknown>;
}

export interface PlanPreview { feasible: boolean; profile: string; planId?: string; plan?: Plan; predicted?: PredictedMetrics;
  budget: PlanExplanation['budget']; candidates: PlanExplanation['candidates']; explanation?: string[] }

export interface Prediction {
  label: string;               // e.g. 'POSITIVE' | 'NEGATIVE' (from the manifest)
  score: number;               // softmax probability of `label`
  logits: [number, number];
  exitAt: 'full' | 'e1' | 'e2';
  /** Chunks (and exit head) this sentence ran through, in order. */
  path: string[];
  /** Time inside the chunk Workers for this sentence, and message-transfer overhead (ms). */
  computeMs: number; transferMs: number;
}

export interface AlternativeFamily {
  family: string; precision: Precision; mode: string; earlyExit: boolean;
  status: 'chosen' | 'feasible' | 'rejected'; detail: string; candidates: number;
  rejected: Partial<Record<'memory' | 'accuracy' | 'unverified', number>>;
}

export interface CacheStats {
  planId: string | null;
  /** true after dispose(): persistent entries are then not read (the cache connection is closed). */
  disposed: boolean;
  persistent: { enabled: boolean; usageMiB: number; entries: { name: string; precision: string; sizeMiB: number; hits: number }[];
                storage: { supported: boolean; quota?: number; usage?: number; persisted?: boolean | null } };
  runtime: { liveWorkers: number; liveWasmMiB: number; peakWasmMiB: number; workerStarts: number; lastInferMs: number | null; requests: number; sentences: number };
}

export declare class AdaptiveModel {
  readonly plan: Plan | null;
  explainPlan(options?: { full?: boolean }): PlanExplanation;
  /** What the engine would choose with these changes; does not change the running plan. */
  previewPlan(changes?: Partial<Pick<LoadOptions, 'profile' | 'overrides' | 'earlyExit'>>): Promise<PlanPreview>;
  infer(text: string): Promise<Prediction>;
  infer(texts: string[]): Promise<Prediction[]>;
  getCacheStats(): Promise<CacheStats>;
  /** Re-decide with changed options; releases the current Workers. */
  replan(changes?: Partial<Pick<LoadOptions, 'profile' | 'overrides' | 'earlyExit'>>): Promise<PlanExplanation>;
  clearCache(): Promise<void>;
  dispose(): void;
}

export type ErrorCode = 'BAD_OPTIONS' | 'NOT_ISOLATED' | 'NO_WORKERS' | 'MANIFEST' | 'NO_FEASIBLE_PLAN' | 'EARLY_EXIT_UNAVAILABLE' | 'DISPOSED';
export declare class AdaptiveLoaderError extends Error { readonly code: ErrorCode; readonly details: Record<string, unknown> }

export declare function loadModel(options: LoadOptions): Promise<AdaptiveModel>;

export declare const PROFILES: Record<ProfileName, { name: ProfileName; deviceMemoryGiB: number; cores: number; downlinkMbps: number; rttMs: number; allowanceMiB: number; minAccuracy: number; weights: Weights }>;
export declare class WordPieceTokenizer {
  static fromVocabText(text: string, opts?: { maxLength?: number }): WordPieceTokenizer;
  encode(text: string, maxLength?: number): number[];
  tokenize(text: string): string[];
}
