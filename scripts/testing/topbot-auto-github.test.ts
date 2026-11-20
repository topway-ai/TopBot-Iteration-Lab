import { describe, expect, it, vi } from "vitest";
import { advanceAutomaticMain, AutomaticCheckPending, requireAutomaticMain, verifyAutomaticCandidate } from "../topbot-auto-github.mjs";

const repo = "/repos/topway-ai/TopBot-Iteration-Lab";
const identity = { id: 1464902386, node_id: "R_kgDOV1Ci8g", full_name: "topway-ai/TopBot-Iteration-Lab" };
const base = "a".repeat(40), head = "b".repeat(40), moved = "c".repeat(40);
const candidate = { pr: 7, base, head, branch: "topbot-auto/layout" };
const mainRef = "refs/heads/main", sourceRef = `refs/heads/${candidate.branch}`;
const mainPath = `${repo}/branches/main`, rulesPath = `${repo}/rules/branches/main`;
const immutablePath = `${repo}/immutable-releases`, pullPath = `${repo}/pulls/7`;
const rulesetPath = (id: number) => `${repo}/rulesets/${id}`;
const commitPath = `${repo}/git/commits/${head}`;
const trustedFiles = [".github/workflows/ci.yml", ".github/workflows/topbot-automatic-review.yml",
  ".github/workflows/topbot-windows-update.yml", "scripts/topbot-auto-review.mjs"];
const trustedPath = (path: string, sha: string) => `${repo}/contents/${path}?ref=${sha}`;
const trustedBlob = (path: string) => ({ type: "file", path, sha: "d".repeat(40) });
const list = (key: string, rows: readonly unknown[]) => ({ total_count: rows.length, [key]: rows });
const runsPath = (workflow: string) => `${repo}/actions/workflows/${workflow}/runs?event=pull_request&head_sha=${head}&per_page=100`;
const jobsPath = (run: { id: number; run_attempt: number }) => `${repo}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`;
const pr = {
  number: 7, state: "open", draft: false, merged: false,
  head: { sha: head, ref: candidate.branch, repo: identity }, base: { sha: base, ref: "main", repo: identity },
};
const link = { number: 7, head: { ...pr.head, repo: { id: identity.id } }, base: { ...pr.base, repo: { id: identity.id } } };
const run = (workflow: string, id: number) => ({
  id, run_attempt: 2, status: "completed", conclusion: "success", event: "pull_request",
  path: `.github/workflows/${workflow}@refs/pull/7/merge`, head_sha: head, head_branch: candidate.branch,
  repository: identity, head_repository: identity, pull_requests: [link],
});
const job = (name: string, runId: number) => ({ id: runId + 100, name, run_id: runId, head_sha: head, status: "completed", conclusion: "success" });
const ci = run("ci.yml", 21), review = run("topbot-automatic-review.yml", 22);
const ciPath = runsPath("ci.yml"), reviewPath = runsPath("topbot-automatic-review.yml");
const reviewJob = job("TopBot automatic review", review.id);
const rules = [{ type: "deletion" }, { type: "non_fast_forward" }, {
  type: "required_status_checks", parameters: { required_status_checks: [
    { context: "CI", integration_id: 15368 }, { context: "TopBot automatic review", integration_id: 15368 },
  ] },
}];
const effective = (rows: typeof rules, id: number) => rows.map(rule => ({ ...rule, ruleset_id: id,
  ruleset_source: identity.full_name, ruleset_source_type: "Repository" }));
const ruleset = (rows: typeof rules, id: number) => ({ id, target: "branch", enforcement: "active",
  source: identity.full_name, source_type: "Repository", rules: rows });

type RefUpdate = { name: string; beforeOid: string; afterOid: string; force: boolean };
type Mutation = { query: string; variables: { input: { repositoryId: string; clientMutationId: string; refUpdates: RefUpdate[] } } };

function fixture() {
  const refs = new Map([[mainRef, base], [sourceRef, head]]);
  const state = { race: "", lostResponse: false, wrongReceipt: false, moveAfterWrite: false };
  const routes = new Map<string, unknown>([
    [rulesPath, effective(rules, 51)], [rulesetPath(51), { ...ruleset(rules, 51), bypass_actors: [] }],
    [immutablePath, { enabled: true }], [pullPath, pr], [commitPath, { sha: head, parents: [{ sha: base }] }],
    [ciPath, list("workflow_runs", [ci])], [reviewPath, list("workflow_runs", [review])],
    [jobsPath(ci), list("jobs", [job("CI", ci.id)])], [jobsPath(review), list("jobs", [reviewJob])],
  ]);
  for (const path of trustedFiles) {
    routes.set(trustedPath(path, base), trustedBlob(path));
    routes.set(trustedPath(path, head), trustedBlob(path));
  }
  const writes: Array<[string, string, Mutation]> = [];
  const request = vi.fn(async (path: string, method?: "POST", body?: unknown) => {
    if (!method) {
      if (routes.has(path)) return routes.get(path);
      if (path === mainPath) return { protected: true, commit: { sha: refs.get(mainRef) } };
      throw new Error(`Unexpected read: ${path}`);
    }
    const mutation = body as Mutation;
    writes.push([path, method, mutation]);
    expect(path).toBe("/graphql");
    expect(method).toBe("POST");
    const { refUpdates, clientMutationId } = mutation.variables.input;
    if (state.race) refs.set(state.race, moved);
    if (refUpdates.some(update => refs.get(update.name) !== update.beforeOid)) {
      return { errors: [{ message: "stale ref" }], data: { updateRefs: null } };
    }
    for (const update of refUpdates) refs.set(update.name, update.afterOid);
    if (state.moveAfterWrite) refs.set(mainRef, moved);
    if (state.lostResponse) throw new Error("Transport failed after writing.");
    return { data: { updateRefs: { clientMutationId: state.wrongReceipt ? moved : clientMutationId } } };
  });
  return { routes, refs, state, writes, request };
}

describe("TopBot automatic main policy", () => {
  it("accepts active rules requiring both Actions contexts, even across separate rulesets", async () => {
    const f = fixture();
    const [ciRule, reviewRule] = ["CI", "TopBot automatic review"].map(context => ({ type: "required_status_checks",
      parameters: { required_status_checks: [{ context, integration_id: 15368 }] } }));
    const first = [...rules.slice(0, 2), { type: "required_linear_history" }, ciRule];
    f.routes.set(rulesPath, [...effective(first, 51), ...effective([reviewRule], 52)]);
    f.routes.set(rulesetPath(51), { ...ruleset(first, 51), bypass_actors: [] });
    f.routes.set(rulesetPath(52), { ...ruleset([reviewRule], 52), updated_at: "2026-11-19T09:00:00-05:00" });
    await expect(requireAutomaticMain(f.request, base)).rejects.toThrow(/unverifiable/);
    await expect(requireAutomaticMain(f.request, base, ["52@2026-11-19T14:00:00Z"])).resolves.toBeUndefined();
    expect(f.request).toHaveBeenCalledWith(rulesetPath(51));
    expect(f.request).toHaveBeenCalledWith(rulesetPath(52));
    expect(f.writes).toEqual([]);
  });

  it.each([
    ["unprotected main", mainPath, { protected: false, commit: { sha: base } }],
    ["moved main", mainPath, { protected: true, commit: { sha: moved } }],
    ["classic review", mainPath, { protected: true, commit: { sha: base }, protection: { required_pull_request_reviews: {} } }],
    ["mutable releases", immutablePath, { enabled: false }],
    ["missing deletion guard", rulesPath, rules.filter(rule => rule.type !== "deletion")],
    ["missing fast-forward guard", rulesPath, rules.filter(rule => rule.type !== "non_fast_forward")],
    ["missing status rules", rulesPath, rules.slice(0, 2)],
    ["missing effective ruleset identity", rulesPath, rules],
    ["disabled readback", rulesetPath(51), { ...ruleset(rules, 51), enforcement: "disabled" }],
    ["mismatched readback", rulesetPath(51), ruleset(rules.slice(0, 2), 51)],
    ["readback with a bypass", rulesetPath(51), { ...ruleset(rules, 51), bypass_actors: [{ actor_id: 2 }] }],
    ["wrong integration", rulesPath, [...rules.slice(0, 2), { type: "required_status_checks", parameters: { required_status_checks: [
      { context: "CI", integration_id: 15368 }, { context: "TopBot automatic review", integration_id: 99 },
    ] } }]],
    ...["pull_request", "required_deployments", "merge_queue", "update"].map(type => [type, rulesPath, [...rules, { type }]] as const),
  ] as const)("stops on %s", async (_, path, value) => {
    const f = fixture();
    f.routes.set(path, value);
    await expect(requireAutomaticMain(f.request, base)).rejects.toThrow();
    expect(f.writes).toEqual([]);
  });
});

describe("TopBot automatic candidate evidence", () => {
  it("binds both final checks to the exact PR and run attempts and returns stable evidence", async () => {
    const f = fixture();
    const expected = { ...candidate, ciRun: 21, ciAttempt: 2, ciJob: 121, reviewRun: 22, reviewAttempt: 2, reviewJob: 122 };
    await expect(verifyAutomaticCandidate(f.request, candidate)).resolves.toEqual(expected);
    await expect(verifyAutomaticCandidate(f.request, candidate)).resolves.toEqual(expected);
    expect(f.request).toHaveBeenCalledWith(jobsPath(ci));
    expect(f.request).toHaveBeenCalledWith(jobsPath(review));
    expect(f.writes).toEqual([]);
  });

  it.each(trustedFiles)("rejects a candidate that rewrites %s despite successful checks", async path => {
    const f = fixture();
    f.routes.set(trustedPath(path, head), { ...trustedBlob(path), sha: moved });
    await expect(advanceAutomaticMain(f.request, candidate)).rejects.toThrow(/changed trusted/);
    expect(f.writes).toEqual([]);
  });

  it.each([
    ["not created", []],
    ["queued", [{ ...review, status: "queued", conclusion: null }]],
    ["in progress", [{ ...review, status: "in_progress", conclusion: null }]],
  ])("uses the polling error when a check is %s", async (_, runs) => {
    const f = fixture();
    f.routes.set(reviewPath, list("workflow_runs", runs));
    await expect(verifyAutomaticCandidate(f.request, candidate)).rejects.toBeInstanceOf(AutomaticCheckPending);
    expect(f.request).not.toHaveBeenCalledWith(jobsPath(review));
    expect(f.writes).toEqual([]);
  });

  it.each([
    ["wrong workflow path", [{ ...review, path: ".github/workflows/elsewhere.yml" }]],
    ["wrong event", [{ ...review, event: "workflow_dispatch" }]],
    ["wrong base", [{ ...review, pull_requests: [{ ...link, base: { ...link.base, sha: moved } }] }]],
    ["wrong target branch", [{ ...review, pull_requests: [{ ...link, base: { ...link.base, ref: "another" } }] }]],
    ["wrong PR", [{ ...review, pull_requests: [{ ...link, number: 8 }] }]],
    ["not PR linked", [{ ...review, pull_requests: [] }]],
    ["ambiguous PR link", [{ ...review, pull_requests: [link, { ...link, number: 8 }] }]],
    ["wrong head", [{ ...review, head_sha: moved }]],
    ["wrong branch", [{ ...review, head_branch: "topbot-auto/other" }]],
    ["forked PR link", [{ ...review, pull_requests: [{ ...link, head: { ...link.head, repo: { id: 2 } } }] }]],
    ["wrong run repo", [{ ...review, head_repository: { ...identity, node_id: "different" } }]],
    ["missing attempt", [{ ...review, run_attempt: undefined }]],
    ["two exact runs", [review, { ...review, id: 23, conclusion: "failure" }]],
    ["failed run", [{ ...review, conclusion: "failure" }]],
  ])("treats %s as terminal even if the other workflow has not started", async (_, runs) => {
    const f = fixture();
    f.routes.set(ciPath, list("workflow_runs", []));
    f.routes.set(reviewPath, list("workflow_runs", runs));
    const result = verifyAutomaticCandidate(f.request, candidate);
    await expect(result).rejects.toThrow();
    await expect(result).rejects.not.toBeInstanceOf(AutomaticCheckPending);
    expect(f.writes).toEqual([]);
  });

  it.each([
    ["missing", []], ["duplicated", [reviewJob, { ...reviewJob, id: 123 }]],
    ["wrong head", [{ ...reviewJob, head_sha: moved }]], ["wrong run", [{ ...reviewJob, run_id: 99 }]],
    ["skipped", [{ ...reviewJob, conclusion: "skipped" }]],
  ])("rejects the exact attempt when its final job is %s", async (_, jobs) => {
    const f = fixture();
    f.routes.set(jobsPath(review), list("jobs", jobs));
    await expect(verifyAutomaticCandidate(f.request, candidate)).rejects.toThrow(/final job/);
    expect(f.request).not.toHaveBeenCalledWith(jobsPath({ ...review, run_attempt: 1 }));
  });

  it.each([ciPath, jobsPath(review)])("does not accept a partial listing at %s", async path => {
    const f = fixture();
    f.routes.set(path, { ...(f.routes.get(path) as object), total_count: 101 });
    await expect(verifyAutomaticCandidate(f.request, candidate)).rejects.toThrow("complete");
  });
});

describe("TopBot automatic ref advancement", () => {
  it("updates only main with one unforced CAS and returns its verified SHA", async () => {
    const f = fixture();
    await expect(advanceAutomaticMain(f.request, candidate)).resolves.toBe(head);
    expect(f.refs.get(mainRef)).toBe(head);
    expect(f.refs.get(sourceRef)).toBe(head);
    expect(f.writes).toEqual([["/graphql", "POST", {
      query: "mutation($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }",
      variables: { input: { repositoryId: identity.node_id, clientMutationId: head, refUpdates: [
        { name: sourceRef, beforeOid: head, afterOid: head, force: false },
        { name: mainRef, beforeOid: base, afterOid: head, force: false },
      ] } },
    }]]);
    expect(f.request).toHaveBeenLastCalledWith(mainPath);
  });

  it.each([
    ["closed PR", pullPath, { ...pr, state: "closed" }], ["draft PR", pullPath, { ...pr, draft: true }],
    ["retargeted PR", pullPath, { ...pr, base: { ...pr.base, ref: "other" } }],
    ["changed PR base", pullPath, { ...pr, base: { ...pr.base, sha: moved } }],
    ["changed PR head", pullPath, { ...pr, head: { ...pr.head, sha: moved } }],
    ["forked PR", pullPath, { ...pr, head: { ...pr.head, repo: { ...identity, id: 2 } } }],
    ["moved main", mainPath, { protected: true, commit: { sha: moved } }],
    ["wrong parent", commitPath, { sha: head, parents: [{ sha: moved }] }],
    ["merge commit", commitPath, { sha: head, parents: [{ sha: base }, { sha: moved }] }],
    ["stale CI", ciPath, list("workflow_runs", [{ ...ci, conclusion: "failure" }])],
  ] as const)("does not attempt a mutation for %s", async (_, path, value) => {
    const f = fixture();
    f.routes.set(path, value);
    await expect(advanceAutomaticMain(f.request, candidate)).rejects.toThrow();
    expect(f.writes).toEqual([]);
  });

  it.each([mainRef, sourceRef])("does not change either ref when %s moves before the atomic write", async race => {
    const f = fixture();
    f.state.race = race;
    await expect(advanceAutomaticMain(f.request, candidate)).rejects.toThrow("did not confirm");
    expect(f.refs.get(mainRef)).toBe(race === mainRef ? moved : base);
    expect(f.refs.get(sourceRef)).toBe(race === sourceRef ? moved : head);
    expect(f.writes).toHaveLength(1);
  });

  it.each(["lostResponse", "wrongReceipt", "moveAfterWrite"] as const)("does not return a SHA or retry after %s", async failure => {
    const f = fixture();
    f.state[failure] = true;
    await expect(advanceAutomaticMain(f.request, candidate)).rejects.toThrow();
    expect(f.writes).toHaveLength(1);
  });

  it.each([{ branch: "main" }, { head: "0".repeat(40) }, { head: base }, { pr: 0 }])("rejects invalid inputs before any reads: %o", async change => {
    const f = fixture();
    await expect(advanceAutomaticMain(f.request, { ...candidate, ...change })).rejects.toThrow("Invalid automatic TopBot candidate");
    expect(f.request).not.toHaveBeenCalled();
  });
});
