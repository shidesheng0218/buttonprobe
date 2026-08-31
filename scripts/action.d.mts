export interface ButtonProbeActionInputs {
  url: string;
  patch?: string;
  patchUrl?: string;
  testCommand: string;
  devCommand: string;
  projectRoot: string;
  output: string;
  target: string;
  browser: string;
  packageVersion: string;
  failOnUnverified: boolean;
  comment?: boolean;
  githubToken?: string;
  timeoutMs: number;
}

export function parseActionInputs(env?: NodeJS.ProcessEnv): ButtonProbeActionInputs;
export function shouldFailAction(status: string, failOnUnverified: boolean): boolean;
export function buildActionArgs(values: ButtonProbeActionInputs): string[];
export function buildProofComment(proof: Record<string, unknown>, values: Pick<ButtonProbeActionInputs, "output">): string;
export function buildJobSummary(proof: Record<string, unknown>, values: Pick<ButtonProbeActionInputs, "output">, comment?: Record<string, unknown>): string;
export function publishPullRequestComment(input: Record<string, unknown>): Promise<{ status: string; url?: string; warning?: string }>;
