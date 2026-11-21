import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { iterateTopBot, IterationGitHubError } from "../topbot-iteration.mjs";
import { TopBotReleaseGateError } from "../topbot-release-gate.mjs";
import { createTopBotIteration, topBotIterationTask } from "../../server/topbot-iteration.ts";

const owner = "topway-ai/TopBot-Iteration-Lab", repo = `/repos/${owner}`;
const identity = { id: 1464902386, node_id: "R_kgDOV1Ci8g", full_name: owner };
const base = "a".repeat(40), head = "b".repeat(40), slug = "fixture", branch = `topbot-auto/${slug}`;
const pr = 17, version = "0.1.161-topbot.9", tag = `v${version}`;
const contexts = ["CI", "TopBot automatic review"];
const ruleEntries = [{ type: "deletion" }, { type: "non_fast_forward" },
  { type: "required_status_checks", parameters: { required_status_checks: contexts.map(context => ({ context, integration_id: 15368 })) } }];
const ref = { ref: `refs/tags/${tag}`, object: { sha: head, type: "commit" } };
const task = "Change the test card heading";

function fixture(block?: "review" | "full-ci" | "full-ci-flake" | "pr-ci-flake" | "review-and-ci" | "legacy" | "publish") {
  const events: string[] = [], writes: string[] = [];
  let current = base, dispatched = false;
  const retried = new Set<number>();
  const dispatchRuns = new Map<number, { branch: string; workflow: string; job: string; fail: boolean }>();
  const develop = vi.fn(async ([cmd]: string[]) => {
    events.push(cmd);
    if (cmd === "start-auto") return { path: resolve("disposable-iteration"), base };
    if (cmd === "candidate") return { pr, base, head, branch };
    if (cmd === "finish" || cmd === "retire-auto") return { archived: true };
    throw Error("Unknown development request");
  });
  const edit = vi.fn(async ({ task: prompt }: { task: string }) => {
    expect(prompt).toBe(task);
    events.push("edit");
  });
  const side = { base: { ref: "main", sha: base, repo: identity }, head: { ref: branch, sha: head, repo: identity } };
  const request = vi.fn(async (path: string, method = "GET", body?: unknown): Promise<unknown> => {
    if (method === "POST") {
      writes.push(path);
      const rerun = /\/actions\/runs\/(1|20)\/rerun-failed-jobs$/.exec(path);
      if (rerun) {
        const id = Number(rerun[1]);
        expect(retried.has(id)).toBe(false);
        retried.add(id);
        return undefined;
      }
      if (path === "/graphql") {
        expect(body).toMatchObject({ variables: { input: { repositoryId: identity.node_id, refUpdates: [
          { name: `refs/heads/${branch}`, beforeOid: head, afterOid: head, force: false },
          { name: "refs/heads/main", beforeOid: base, afterOid: head, force: false },
        ] } } });
        current = head;
        return { data: { updateRefs: { clientMutationId: head } } };
      }
      if (path.endsWith("/ci.yml/dispatches")) {
        expect(body).toEqual({ ref: branch });
        dispatchRuns.set(20, { branch, workflow: "ci", job: "CI", fail: block === "full-ci" || block === "full-ci-flake" });
        return { workflow_run_id: 20 };
      }
      if (path.endsWith("/topbot-windows-update.yml/dispatches")) {
        if (current === base) {
          expect(body).toMatchObject({ ref: branch, inputs: { publish: "false", reviewed_sha: head } });
          dispatchRuns.set(21, { branch, workflow: "topbot-windows-update", job: "build", fail: false });
          return { workflow_run_id: 21 };
        }
        expect(body).toMatchObject({ ref: "main", inputs: { publish: "true", reviewed_sha: head, reviewed_tag_ruleset: "72@2026-11-19T12:00:00Z", verified_ci_run: "20" } });
        dispatchRuns.set(22, { branch: "main", workflow: "topbot-windows-update", job: "publish", fail: block === "publish" });
        dispatched = true;
        return { workflow_run_id: 22 };
      }
      throw Error(`Unknown write ${path}`);
    }
    const route = path.slice(repo.length).split("?")[0];
    if (route === "/branches/main") return { protected: true, commit: { sha: current } };
    if (route === "/rules/branches/main") return [...ruleEntries, ...(block === "legacy" ? [{ type: "pull_request" }] : [])]
      .map(rule => ({ ...rule, ruleset_id: 33, ruleset_source: owner, ruleset_source_type: "Repository" }));
    if (route === "/rulesets/33") return { id: 33, source: owner, source_type: "Repository", target: "branch", enforcement: "active", rules: ruleEntries, bypass_actors: [] };
    if (route === "/immutable-releases") return { enabled: true };
    if (route === "/contents/package.json") return { type: "file", encoding: "base64",
      content: Buffer.from(JSON.stringify({ version: path.endsWith(base) ? "0.1.161-topbot.8" : version })).toString("base64") };
    if (route.startsWith("/contents/")) return { type: "file", path: route.slice(10), sha: "d".repeat(40) };
    if (route === `/git/commits/${head}`) return { sha: head, parents: [{ sha: base }] };
    if (route === `/pulls/${pr}`) return { number: pr, state: "open", draft: false, merged: false, ...side };
    if (route === "/rulesets") return [{ id: 72, enforcement: "active" }];
    if (route === "/rulesets/72") return { id: 72, source: owner, source_type: "Repository", enforcement: "active", target: "tag", bypass_actors: [],
      updated_at: "2026-11-19T12:00:00Z", conditions: { ref_name: { exclude: [], include: ["refs/tags/v*"] } }, rules: [{ type: "update" }, { type: "deletion" }] };
    if (route === `/git/ref/tags/${tag}`) {
      if (!dispatched) throw new IterationGitHubError(404);
      return ref;
    }
    if (route === `/releases/tags/${tag}`) {
      if (!dispatched || block === "publish") throw new IterationGitHubError(404);
      return { tag_name: tag, target_commitish: head, immutable: true, prerelease: false,
        assets: [{ name: "topbot-windows-update.json" }, { name: `TopBot-${version}-x64.zip` }] };
    }
    const dispatchedRun = /^\/actions\/runs\/(2[012])(?:\/attempts\/([12])\/jobs)?$/.exec(route);
    if (dispatchedRun) {
      const id = Number(dispatchedRun[1]);
      const run = dispatchRuns.get(id)!;
      const attempt = retried.has(id) ? 2 : 1;
      const result = run.fail && !(block === "full-ci-flake" && attempt === 2) ? "failure" : "success";
      if (dispatchedRun[2]) {
        expect(Number(dispatchedRun[2])).toBe(attempt);
        return { jobs: [{ name: run.job, head_sha: head, run_id: id, status: "completed", conclusion: result }] };
      }
      return { id, run_attempt: attempt, event: "workflow_dispatch", head_sha: head, head_branch: run.branch,
        path: `.github/workflows/${run.workflow}.yml`, head_repository: identity, status: "completed", conclusion: result };
    }
    if (route.endsWith("/runs")) {
      const wf = route.split("/").at(-2);
      const isReview = wf === "topbot-automatic-review.yml";
      const failed = isReview ? block === "review" || block === "review-and-ci"
        : block === "review-and-ci" || (block === "pr-ci-flake" && !retried.has(1));
      return { total_count: 1, workflow_runs: [{ id: isReview ? 2 : 1, run_attempt: !isReview && retried.has(1) ? 2 : 1, event: "pull_request", head_sha: head,
        head_branch: branch, head_repository: identity, repository: identity, path: `.github/workflows/${wf}`,
        pull_requests: [{ number: pr, ...side }], status: "completed", conclusion: failed ? "failure" : "success" }] };
    }
    if (route.endsWith("/jobs")) {
      const id = route.includes("/runs/2/") ? 2 : 1;
      return { total_count: 1, jobs: [{ name: contexts[id - 1], run_id: id, id: id + 10, head_sha: head, status: "completed", conclusion: "success" }] };
    }
    throw Error(`Unexpected read: ${path}`);
  });
  const verify = vi.fn(async (_reader: unknown, sha: string, prNumber: number, ciRun: number) => {
    expect(sha).toBe(head);
    expect(prNumber).toBe(pr);
    expect(ciRun).toBe(20);
    return { sha, pullRequest: pr };
  });
  const run = async (input: string, preparePublication?: Parameters<typeof iterateTopBot>[1]["preparePublication"]) =>
    iterateTopBot(input, { request, develop, edit, verify, slug, preparePublication });
  return { develop, edit, request, verify, events, writes, run };
}

describe("one chat instruction starts an automatic iteration", () => {
  it("edits, checks, advances, builds and reports an immutable release without a human gate", async () => {
    const f = fixture();
    const message = topBotIterationTask(`/topbot-iterate ${task}`);
    const report = vi.fn();
    const run = createTopBotIteration({ run: async (input) => ({ ok: true, ...await f.run(input) }) });
    expect(run(message!.task, report)).toContain("开始自动迭代");
    await vi.waitFor(() => expect(report).toHaveBeenCalledOnce());
    expect(report).toHaveBeenCalledWith(expect.stringContaining(version));
    expect(f.events).toEqual(["start-auto", "edit", "candidate", "finish"]);
    expect(f.writes).toEqual([`${repo}/actions/workflows/ci.yml/dispatches`, `${repo}/actions/workflows/topbot-windows-update.yml/dispatches`,
      "/graphql", `${repo}/actions/workflows/topbot-windows-update.yml/dispatches`]);
    expect(f.request.mock.calls.some(([p]) => p.endsWith("/reviews"))).toBe(false);
  });

  it("does not edit or write to a production repo still configured with a human gate", async () => {
    const f = fixture("legacy");
    await expect(f.run(task)).rejects.toThrow(/manual or unsupported/);
    expect(f.edit).not.toHaveBeenCalled();
    expect(f.writes).toEqual([]);
  });

  it.each(["review", "review-and-ci"] as const)("does not rerun or advance main when automated %s fails", async (block) => {
    const f = fixture(block);
    await expect(f.run(task)).rejects.toThrow(/did not finish successfully/);
    expect(f.writes).toEqual([]);
  });

  it("retires only the failed editor job without calling a GitHub write", async () => {
    const f = fixture();
    f.edit.mockRejectedValueOnce(new Error("editor stopped"));
    await expect(f.run(task)).rejects.toThrow("editor stopped");
    expect(f.develop).toHaveBeenLastCalledWith(["retire-auto", slug]);
    expect(f.writes).toEqual([]);
  });

  it("does not advance main when the exact qualified artifact cannot be downloaded", async () => {
    const f = fixture();
    const prepare = vi.fn(async () => { throw new Error("artifact digest mismatch"); });
    await expect(f.run(task, prepare)).rejects.toThrow("artifact digest mismatch");
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ head, branch, version }), expect.any(Function));
    expect(f.writes).toEqual([`${repo}/actions/workflows/ci.yml/dispatches`, `${repo}/actions/workflows/topbot-windows-update.yml/dispatches`]);
  });

  it.each([["pr-ci-flake", 1], ["full-ci-flake", 20]] as const)("automatically reruns only the exact CI workflow for %s", async (block, id) => {
    const f = fixture(block);
    let time = 0;
    await expect(f.run(task, undefined, { now: () => time, sleep: async ms => { time += ms; } })).resolves.toMatchObject({ sha: head });
    expect(f.writes.filter(p => p.endsWith("/rerun-failed-jobs"))).toEqual([`${repo}/actions/runs/${id}/rerun-failed-jobs`]);
    expect(f.writes.indexOf(`${repo}/actions/runs/${id}/rerun-failed-jobs`)).toBeLessThan(f.writes.indexOf("/graphql"));
  });

  it("does not advance main or dispatch release when full candidate CI fails again", async () => {
    const f = fixture("full-ci");
    let time = 0;
    await expect(f.run(task, undefined, { now: () => time, sleep: async ms => { time += ms; } })).rejects.toMatchObject({
      constructor: TopBotReleaseGateError,
      message: "ci did not complete successfully. GitHub Actions run 20 (CI: failure).",
      retryable: false,
    });
    expect(f.writes).toEqual([`${repo}/actions/workflows/ci.yml/dispatches`, `${repo}/actions/runs/20/rerun-failed-jobs`]);
  });

  it("does not report a release after GitHub packaging fails", async () => {
    const f = fixture("publish");
    await expect(f.run(task)).rejects.toThrow("topbot-windows-update did not complete successfully");
    expect(f.writes.filter(p => p.endsWith("/topbot-windows-update.yml/dispatches"))).toHaveLength(2);
  });
});
