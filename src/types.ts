export type ControlVerdict =
  | "WORKS"
  | "INERT"
  | "CRASHED"
  | "AMBIGUOUS"
  | "BACKEND_ERROR"
  | "AUTH_REQUIRED"
  | "RATE_LIMITED"
  | "NETWORK_ERROR"
  | "BLOCKED_MUTATION"
  | "SKIPPED";
export type NetworkSafetyMode = "observe" | "sandbox" | "replay";
export type FailureClass =
  | "FRONTEND_INERT"
  | "FRONTEND_CRASH"
  | "BACKEND_4XX"
  | "BACKEND_5XX"
  | "AUTH_REQUIRED"
  | "RATE_LIMITED"
  | "NETWORK_TIMEOUT"
  | "NETWORK_ERROR"
  | "BLOCKED_MUTATION"
  | "AMBIGUOUS";

export interface BusinessProfile {
  storageState?: string;
  routes?: string[];
  networkMode?: NetworkSafetyMode;
  replayHar?: string;
  setupCommand?: string;
  resetCommand?: string;
}

export interface ControlSignal {
  type: "url" | "dom" | "aria" | "network" | "dialog" | "download" | "popup" | "console";
  detail: string;
}

export interface ControlEvidence {
  beforeScreenshot: string;
  afterScreenshot: string;
  signals: ControlSignal[];
}

export interface BehaviorContractExpectations {
  text?: string[];
  visible?: string[];
  urlIncludes?: string;
  network?: string[];
}

export interface BehaviorContractForbids {
  text?: string[];
  urlIncludes?: string;
  consoleError?: boolean;
}

export interface BehaviorContract {
  expect?: BehaviorContractExpectations;
  forbid?: BehaviorContractForbids;
}

export type ScenarioAction = {
  type: "click";
  selector: string;
};

export type ScenarioExpectation =
  | { type: "text"; value: string }
  | { type: "visible"; selector: string }
  | { type: "urlIncludes"; value: string }
  | { type: "network"; value: string };

export type ScenarioForbid =
  | { type: "text"; value: string }
  | { type: "urlIncludes"; value: string }
  | { type: "consoleError" }
  | { type: "network"; value: string };

export interface ScenarioContract {
  route?: string;
  target: string;
  actions: ScenarioAction[];
  expect?: ScenarioExpectation[];
  forbid?: ScenarioForbid[];
}

export interface BehaviorContractVerification {
  passed: boolean;
  checks: string[];
  failures: string[];
}

export interface RepairIssue {
  controlId: string;
  pageUrl: string;
  selector?: string;
  label: string;
  verdict: Exclude<
    ControlVerdict,
    "WORKS" | "SKIPPED" | "BLOCKED_MUTATION" | "BACKEND_ERROR" | "AUTH_REQUIRED" | "RATE_LIMITED" | "NETWORK_ERROR"
  >;
  evidence: ControlEvidence;
  behaviorContract?: BehaviorContract;
}

export interface SourceCandidate {
  path: string;
  content: string;
  score?: number;
  reason?: string;
  strongIdentity?: boolean;
  eventChain?: {
    control: string;
    handler?: string;
    calls: string[];
    imports: string[];
    parentCandidates: string[];
  };
}

export type SourceCandidateEvidence = Pick<SourceCandidate, "path" | "score" | "reason" | "strongIdentity" | "eventChain">;

export type ProofStatus = "patch-generated" | "patch-applies" | "test-verified" | "ui-verified" | "rejected";
export type RepairEvidenceStatus = "generated" | "test-verified" | "ui-verified" | "failed";

export interface RepairAttempt {
  diagnosis: string;
  sourceConfidence: number;
  expectedOutcome: string;
  patch: string;
  affectedControls: string[];
  risk: "low" | "medium" | "high";
}

export interface PatchValidation {
  ok: boolean;
  files: string[];
  changedLines?: number;
  reason?: string;
}

export interface TestResult {
  passed: boolean;
  command: string;
  output: string;
}

export interface UIVerification {
  targetWorks: boolean;
  regressions: string[];
  browsers?: UIBrowserResult[];
  evidence?: ControlEvidence;
  counterfactual?: {
    baselineFailed: boolean;
    patchedPassed: boolean;
  };
  behaviorContract?: BehaviorContractVerification;
}

export type BrowserName = "chromium" | "firefox" | "webkit";

export interface UIBrowserResult {
  browser: BrowserName;
  status: "passed" | "failed" | "unavailable";
  targetWorks: boolean;
  regressions: string[];
  scenarioFailures?: string[];
  screenshot?: string;
  error?: string;
}

export interface RepairRequestContext {
  issue: RepairIssue;
  sources: SourceCandidate[];
  round: number;
  previousAttempts: RepairAttemptRecord[];
}

export interface RepairDependencies {
  locateSources(issue: RepairIssue): Promise<SourceCandidate[]>;
  requestRepair(context: RepairRequestContext): Promise<RepairAttempt>;
  validatePatch(patch: string): Promise<PatchValidation>;
  applyPatch(patch: string): Promise<void>;
  rollbackPatch(patch: string): Promise<void>;
  runTests(): Promise<TestResult>;
  verifyUI(issue: RepairIssue): Promise<UIVerification>;
}

export interface RepairAttemptRecord {
  round: number;
  attempt?: RepairAttempt;
  validation?: PatchValidation;
  tests?: TestResult;
  ui?: UIVerification;
  decision: "accepted" | "rolled-back" | "rejected";
  reason: string;
}

export interface RepairLoopResult {
  status: "fixed" | "exhausted" | "blocked";
  attempts: RepairAttemptRecord[];
  stopReason: string;
  evidenceStatus?: RepairEvidenceStatus;
  regressionTestPath?: string;
  counterfactualVerified?: boolean;
}

export interface AIUsageEvent {
  kind: "analyze" | "repair";
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  cached: boolean;
  success: boolean;
  error?: string;
}

export interface AIUsageSummary {
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  cacheHits: number;
  cacheMisses: number;
  estimatedCostUsd?: number;
  events: AIUsageEvent[];
}

export interface ModelDataManifest {
  endpointHost: string;
  sourceFiles: string[];
  screenshotCount: number;
  redactionApplied: boolean;
}

export interface ProofArtifacts {
  verifiedDiff?: string;
  proof?: string;
  testLog?: string;
  screenshots?: string[];
}

export interface ScanControl {
  id: string;
  pageUrl: string;
  selector: string;
  tagName: string;
  type: string;
  text: string;
  ariaLabel: string;
  testId: string;
  probeId?: string;
  verdict: ControlVerdict;
  failureClass?: FailureClass;
  dangerousReason?: string;
  evidence: ControlEvidence;
}

export interface PageScan {
  url: string;
  title: string;
  screenshot: string;
  controls: ScanControl[];
  errors: string[];
}

export interface ScanResult {
  schemaVersion: 1;
  startedAt: string;
  durationMs: number;
  baseUrl: string;
  pages: PageScan[];
}

export interface AIControlAssessment {
  controlId: string;
  expectedBehavior: string;
  observedBehavior: string;
  verdict: Exclude<ControlVerdict, "SKIPPED">;
  confidence: number;
  explanation: string;
  suggestedFix?: string;
  suggestedTest?: string;
}

export interface AIPageAssessment {
  schemaVersion: 1;
  pageUrl: string;
  assessments: AIControlAssessment[];
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  latencyMs: number;
  cached: boolean;
}
