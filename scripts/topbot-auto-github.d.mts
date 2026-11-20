export type AutomaticCandidate = Readonly<{ pr: number; base: string; head: string; branch: string }>;
export type AutomaticReviewEvidence = AutomaticCandidate & Readonly<{
  ciRun: number; ciAttempt: number; ciJob: number;
  reviewRun: number; reviewAttempt: number; reviewJob: number;
}>;

type Read = (path: string) => Promise<unknown>;
type Request = (path: string, method?: "POST", body?: unknown) => Promise<unknown>;

export class AutomaticCheckPending extends Error {}
export function requireAutomaticMain(read: Read, expectedSha: string, attestations?: string[]): Promise<void>;
export function verifyAutomaticCandidate(read: Read, candidate: AutomaticCandidate): Promise<AutomaticReviewEvidence>;
export function advanceAutomaticMain(request: Request, candidate: AutomaticCandidate): Promise<string>;
