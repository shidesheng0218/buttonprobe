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
}

export function parseActionInputs(env?: NodeJS.ProcessEnv): ButtonProbeActionInputs;
export function shouldFailAction(status: string, failOnUnverified: boolean): boolean;
export function buildActionArgs(values: ButtonProbeActionInputs): string[];
