export interface BenchmarkSummaryOptions {
  viralPath: string;
  reactPath: string;
  outputPath: string;
  readmePath: string;
}

export function updateBenchmarkSummary(options: BenchmarkSummaryOptions): Promise<{
  schemaVersion: 1;
  viral: Record<string, unknown>;
  react: Record<string, unknown>;
}>;
