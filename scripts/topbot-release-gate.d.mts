export class TopBotReleaseGateError extends Error {
  readonly retryable: boolean;
}
export function verifyWindowsReleaseGate(read: (path: string) => Promise<unknown>, sha: string, expectedPR?: number, expectedRunId?: number, attestations?: string[]): Promise<{
  pullRequest: number; head: string; base: string; sha: string; tree: string; ciRun: number; ciAttempt: number; approval: number;
}>;
