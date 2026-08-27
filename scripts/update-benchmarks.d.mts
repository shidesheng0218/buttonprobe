export interface BenchmarkSummaryOptions {
  viralPath: string;
  reactPath: string;
  vuePath?: string;
  mutationReactPath?: string;
  mutationVuePath?: string;
  externalPath?: string;
  outputPath: string;
  readmePath: string;
}

export function updateBenchmarkSummary(options: BenchmarkSummaryOptions): Promise<{
  schemaVersion: 1;
  viral: Record<string, unknown>;
  react: Record<string, unknown>;
  vue?: Record<string, unknown>;
  mutationReact?: Record<string, unknown>;
  mutationVue?: Record<string, unknown>;
  external?: Record<string, unknown>;
}>;
