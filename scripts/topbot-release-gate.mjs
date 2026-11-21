import { AutomaticCheckPending, maxCiAttempts, requireAutomaticMain, verifyAutomaticCandidate } from "./topbot-auto-github.mjs";

const repository = "topway-ai/TopBot-Iteration-Lab";
const repositoryId = "R_kgDOV1Ci8g";
const repo = `/repos/${repository}`;
const shaPattern = /^[a-f0-9]{40}$/;
const isId = (value) => Number.isSafeInteger(value) && value > 0;
const sameRepo = (value) => value?.full_name === repository && value?.node_id === repositoryId;
const withoutMergeCommit = (pr) => pr?.merge_commit_sha == null;
const mergeMatches = (pr, sha) => pr?.merge_commit_sha === sha ||
  (withoutMergeCommit(pr) && pr?.state === "closed" && pr.head?.sha === sha);

export class TopBotReleaseGateError extends Error {
  constructor(message, { retryable = false } = {}) { super(message); this.retryable = retryable; }
}
const requireGate = (condition, reason) => {
  if (!condition) throw new TopBotReleaseGateError(reason);
};

/** Both chat and the workflow must validate the same read-only production policy. */
export async function verifyWindowsReleaseGate(read, sha, expectedPR, expectedRunId, attestations) {
  requireGate(typeof sha === "string" && shaPattern.test(sha), "无效的待发布提交。");
  await requireAutomaticMain(read, sha, attestations);
  const matches = await read(`${repo}/commits/${sha}/pulls?per_page=100`);
  requireGate(Array.isArray(matches) && matches.length < 100, "无法唯一确定该提交的来源 PR。");
  const merged = matches.filter(pr => isId(pr?.number) && mergeMatches(pr, sha));
  requireGate(expectedPR === undefined ? merged.length === 1 : isId(expectedPR) && merged.every(pr => pr.number === expectedPR),
    "该提交不是指定 PR 的唯一合并提交。");
  const number = expectedPR ?? merged[0].number;
  const pr = await read(`${repo}/pulls/${number}`);
  if (pr?.state === "open" && expectedPR === pr.number) throw new TopBotReleaseGateError("等待 GitHub 记录自动合并。", { retryable: true });
  if (!merged.length && expectedPR === pr?.number && pr?.merged === true && mergeMatches(pr, sha)) {
    throw new TopBotReleaseGateError("等待 GitHub 记录自动合并。", { retryable: true });
  }
  requireGate(merged.length === 1 && pr?.number === number && mergeMatches(pr, sha) && pr.state === "closed" &&
    pr.merged === true && pr.draft === false && pr.base?.ref === "main" && sameRepo(pr.base.repo) &&
    pr.head?.sha === sha && sameRepo(pr.head.repo) && /^topbot-auto\/[a-z0-9][a-z0-9-]{0,39}$/.test(pr.head.ref),
  "指定 PR 未按自动检查流程合并到受保护的 main。");
  const commit = await read(`${repo}/commits/${sha}`);
  requireGate(commit?.sha === sha && Array.isArray(commit.parents) && commit.parents.length === 1 &&
    shaPattern.test(commit.parents[0]?.sha) && typeof commit.commit?.tree?.sha === "string" && shaPattern.test(commit.commit.tree.sha),
  "main 上的提交不是经过自动审核的单一快照。");
  // GitHub's ref-update fast-forward closes the PR without creating a merge commit.
  let mergedWindow;
  if (withoutMergeCommit(pr)) {
    const opened = Date.parse(pr.created_at), mergedAt = Date.parse(pr.merged_at);
    requireGate(pr.base.sha === commit.parents[0].sha && Number.isFinite(opened) && Number.isFinite(mergedAt) && mergedAt >= opened,
      "快进合并的原始 PR 或合并记录不匹配。");
    mergedWindow = { opened, merged: mergedAt };
  }
  let automatic;
  try {
    automatic = await verifyAutomaticCandidate(read, { pr: pr.number, head: sha, base: commit.parents[0].sha, branch: pr.head.ref }, { mergedWindow });
  } catch (error) {
    if (error instanceof AutomaticCheckPending) throw new TopBotReleaseGateError("尚未取得确切提交的自动审核结果。", { retryable: true });
    throw error;
  }
  // Manual runs of ci.yml use its full cross-platform lane, not the selective PR/push lane.
  requireGate(expectedRunId === undefined || isId(expectedRunId), "无效的完整 CI 运行编号。");
  const run = expectedRunId
    ? await read(`${repo}/actions/runs/${expectedRunId}`)
    : (await read(`${repo}/actions/workflows/ci.yml/runs?event=workflow_dispatch&branch=${encodeURIComponent(pr.head.ref)}&head_sha=${sha}&per_page=1`))?.workflow_runs?.[0];
  if (!run || (run.head_sha === sha && run.status !== "completed")) {
    throw new TopBotReleaseGateError("完整 CI 尚在进行。", { retryable: true });
  }
  requireGate(isId(run?.id) && (expectedRunId === undefined || run.id === expectedRunId) &&
    isId(run.run_attempt) && run.run_attempt <= maxCiAttempts &&
    run.event === "workflow_dispatch" && run.head_sha === sha && run.head_branch === pr.head.ref &&
    sameRepo(run.head_repository) && run.path?.split("@", 1)[0] === ".github/workflows/ci.yml" &&
    run.status === "completed" && run.conclusion === "success", "确切 main 提交的完整 CI 尚未通过。");
  const jobs = await read(`${repo}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
  requireGate(Array.isArray(jobs?.jobs) && jobs.jobs.some(job => job?.name === "CI" && job.head_sha === sha &&
    job.status === "completed" && job.conclusion === "success"), "完整 CI 的最终检查没有成功。");
  return { pullRequest: pr.number, head: pr.head.sha, base: commit.parents[0].sha, sha, tree: commit.commit.tree.sha,
    ciRun: run.id, ciAttempt: run.run_attempt, approval: automatic.reviewJob };
}
