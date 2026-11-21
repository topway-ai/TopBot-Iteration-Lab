import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { publishWindowsUpdate } from "../publish-topbot-windows.mjs";
import { resolveTagRulesetProof } from "../topbot-tag-ruleset.mjs";

const repo = "topway-ai/TopBot-Iteration-Lab", version = "0.1.161-topbot.9", tag = `v${version}`;
const archive = `TopBot-${version}-x64.zip`, manifest = "topbot-windows-update.json";
const bytes = Buffer.from("qualified archive"), sha = "a".repeat(40);
const base = "b".repeat(40), tree = "d".repeat(40), branch = "topbot-auto/fixture";
const repoRef = { id: 1464902386, full_name: repo, node_id: "R_kgDOV1Ci8g" };
const mergedPR = { number: 7, merge_commit_sha: sha, state: "closed", merged: true, draft: false,
  base: { ref: "main", sha: base, repo: repoRef }, head: { ref: branch, sha, repo: repoRef } };
const checkNames = ["CI", "TopBot automatic review"];
const releaseRules = [{ type: "deletion" }, { type: "non_fast_forward" },
  { type: "required_status_checks", parameters: {
    required_status_checks: checkNames.map(context => ({ context, integration_id: 15368 })) } }];
const autoPolicy = releaseRules.map(rule => ({ ...rule, ruleset_id: 55, ruleset_source: repo, ruleset_source_type: "Repository" }));
const prRun = (workflow: string, id: number) => ({ id, run_attempt: 1, event: "pull_request", head_sha: sha, head_branch: branch,
  head_repository: repoRef, repository: repoRef, path: `.github/workflows/${workflow}`, status: "completed", conclusion: "success",
  pull_requests: [{ number: 7, base: mergedPR.base, head: mergedPR.head }] });
const ci = { id: 98, run_attempt: 1, event: "workflow_dispatch", head_sha: sha, head_branch: branch,
  head_repository: repoRef, path: ".github/workflows/ci.yml", status: "completed", conclusion: "success" };
const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const rule = { id: 42, updated_at: "2026-11-18T20:00:00Z", source_type: "Repository", source: repo,
  target: "tag", enforcement: "active", conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
  bypass_actors: [], rules: [{ type: "update" }, { type: "deletion" }] };
const proof = `42@${rule.updated_at}`;
const ownerRun = { GH_TOKEN: "fixture", GITHUB_SHA: sha, REVIEWED_SHA: sha, GITHUB_ACTOR: "topway-ai",
  GITHUB_TRIGGERING_ACTOR: "topway-ai", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REPOSITORY: repo,
  GITHUB_REF: "refs/heads/main", REVIEWED_TAG_RULESET: proof, TOPBOT_RELEASE_POLICY_TOKEN: "read-only-fixture" };
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "topbot-publication-"));
  await writeFile(join(directory, archive), bytes);
  await writeFile(join(directory, manifest), JSON.stringify({ schema: 1, repository: repo, platform: "win32-x64", version,
    dataEpoch: 1, bytes: bytes.length, unpackedBytes: bytes.length, sha256: digest(bytes),
    url: `https://github.com/${repo}/releases/download/${tag}/${archive}` }));
});
afterEach(() => rm(directory, { recursive: true, force: true }));

type Intercept = (call: string, visit: number) => Response | undefined;
const json = (value: unknown, status = 200) => Response.json(value, { status });
function github(intercept?: Intercept) {
  const calls: string[] = [], writes: string[] = [];
  const ref = { ref: `refs/tags/${tag}`, object: { type: "commit", sha } };
  const draft = { id: 12, draft: true, tag_name: tag, assets: [] as { name: string; state: string; size: number; digest: string }[] };
  let created = false;
  const request = async (url: string, init: RequestInit) => {
    const { origin, pathname, search } = new URL(url);
    expect(pathname.startsWith(`/repos/${repo}/`)).toBe(true);
    const path = pathname.slice(`/repos/${repo}/`.length);
    const call = `${init.method} ${path}`;
    calls.push(call);
    if (init.method !== "GET") {
      writes.push(call);
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer fixture");
    }
    expect(origin).toBe(init.body instanceof Blob ? "https://uploads.github.com" : "https://api.github.com");
    const override = intercept?.(call, calls.filter(entry => entry === call).length);
    if (override) return override;
    if (/^GET contents\/(?:\.github\/workflows\/|scripts\/topbot-auto-review)/.test(call)) {
      return json({ type: "file", path: path.slice("contents/".length), sha: tree });
    }
    switch (call) {
      case "GET branches/main":
        expect(new Headers(init.headers).get("authorization")).toBe("Bearer read-only-fixture");
        return json({ protected: true, commit: { sha } });
      case "GET rules/branches/main": return json(autoPolicy);
      case "GET rulesets/55": return json({ id: 55, source: repo, source_type: "Repository", target: "branch", enforcement: "active", rules: releaseRules, bypass_actors: [] });
      case "GET immutable-releases": return json({ enabled: true });
      case `GET commits/${sha}/pulls`: return json([mergedPR]);
      case "GET pulls/7": return json(mergedPR);
      case `GET commits/${sha}`: return json({ sha, parents: [{ sha: base }], commit: { tree: { sha: tree } } });
      case "GET actions/workflows/ci.yml/runs":
        if (search.includes("event=pull_request")) return json({ total_count: 1, workflow_runs: [prRun("ci.yml", 96)] });
        expect(search).toBe(`?event=workflow_dispatch&branch=${encodeURIComponent(branch)}&head_sha=${sha}&per_page=1`);
        return json({ workflow_runs: [ci] });
      case "GET actions/workflows/topbot-automatic-review.yml/runs":
        return json({ total_count: 1, workflow_runs: [prRun("topbot-automatic-review.yml", 97)] });
      case "GET actions/runs/96/attempts/1/jobs":
      case "GET actions/runs/97/attempts/1/jobs": {
        const id = call.includes("/96/") ? 96 : 97;
        return json({ total_count: 1, jobs: [{ name: checkNames[id - 96], id: 300 + id, run_id: id, head_sha: sha,
          status: "completed", conclusion: "success" }] });
      }
      case "GET actions/runs/98/attempts/1/jobs":
        return json({ jobs: [{ name: "CI", head_sha: sha, status: "completed", conclusion: "success" }] });
      case "GET contents/package.json": return json({ type: "file", encoding: "base64",
        content: Buffer.from('{"version":"0.1.161-topbot.8"}').toString("base64") });
      case "GET rulesets": return json([rule]);
      case "GET rulesets/42": return json(rule);
      case "GET releases": return json(created ? [draft] : []);
      case "GET releases/12": return json(draft);
      case "POST git/refs":
        expect(JSON.parse(String(init.body))).toEqual({ ref: ref.ref, sha });
        return json(ref, 201);
      case `GET git/ref/tags/${tag}`: return json(ref);
      case "POST releases":
        expect(JSON.parse(String(init.body))).toMatchObject({ draft: true, tag_name: tag, target_commitish: sha });
        created = true;
        return json(draft, 201);
      case "POST releases/12/assets": {
        const blob = init.body as Blob;
        const asset = { name: new URLSearchParams(search).get("name")!, size: blob.size, state: "uploaded",
          digest: `sha256:${digest(new Uint8Array(await blob.arrayBuffer()))}` };
        draft.assets.push(asset);
        return json(asset, 201);
      }
      case "PATCH releases/12":
        expect(JSON.parse(String(init.body))).toEqual({ draft: false, tag_name: tag, target_commitish: sha, prerelease: false, make_latest: "false" });
        return json({ ...draft, draft: false, prerelease: false, immutable: true });
      default: throw new Error(`Unexpected request: ${call}`);
    }
  };
  return { calls, writes, run: (env = ownerRun) => publishWindowsUpdate(directory, version, env, request) };
}

describe("owner's tag ruleset proof", () => {
  const resolve = (detail: unknown) => resolveTagRulesetProof(async (path: string) =>
    path.includes("?") ? [{ id: 42, enforcement: "active" }] : detail, tag);
  it("returns an exact revision only for an applicable, active, non-bypassable repository tag ruleset", async () => {
    expect(await resolve(rule)).toBe(proof);
    for (const change of [
      { target: "branch" }, { source_type: "Organization" }, { source: "other/repo" }, { enforcement: "evaluate" },
      { bypass_actors: undefined }, { bypass_actors: [{}] }, { updated_at: undefined }, { id: 43 },
      { conditions: { ref_name: { include: ["refs/tags/b*"], exclude: [] } } },
      { conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [`refs/tags/${tag}`] } } },
      { rules: [{ type: "non_fast_forward" }, { type: "deletion" }] }, { rules: [{ type: "update" }] },
      { rules: [...rule.rules, { type: "creation" }] },
    ]) expect(await resolve({ ...rule, ...change })).toBeNull();
    const { bypass_actors: _redacted, ...redacted } = rule;
    expect(await resolve(redacted)).toBeNull();
  });
  it("normalizes GitHub timezone offsets without discarding subsecond revision changes", async () => {
    for (const updated_at of ["2026-11-18T15:00:00.035-05:00", "2026-11-18T20:00:00.035000000Z"]) {
      expect(await resolve({ ...rule, updated_at })).toBe("42@2026-11-18T20:00:00.035Z");
    }
    expect(await resolve({ ...rule, updated_at: "2026-11-19T01:30:00.035000001+05:30" }))
      .toBe("42@2026-11-18T20:00:00.035000001Z");
    expect(await resolve({ ...rule, updated_at: "2026-11-18T20:00:00.035+99:00" })).toBeNull();
  });
  it("bounds discovery when no suitable ruleset exists; unknown API state is ineligible", async () => {
    const list = vi.fn(async () => Array.from({ length: 10 }, () => ({ id: 1, enforcement: "disabled" })));
    expect(await resolveTagRulesetProof(list, tag)).toBeNull();
    expect(list).toHaveBeenCalledTimes(2);
    expect(await resolveTagRulesetProof(async () => { throw Error("403"); }, tag)).toBeNull();
  });
});

describe("publish the qualified Windows build", () => {
  const mergedAt = "2026-11-20T06:59:48Z";
  const openedAt = "2026-11-20T05:24:20Z";

  it.each([null, undefined])("accepts a reviewed fast-forward without a merge commit (%s)", async mergeCommit => {
    const fastForward = { ...mergedPR, merge_commit_sha: mergeCommit, created_at: openedAt, merged_at: mergedAt };
    const { run, writes } = github(call =>
      call === `GET commits/${sha}/pulls` ? json([fastForward]) : call === "GET pulls/7" ? json(fastForward) : undefined);
    await expect(run()).resolves.toBeUndefined();
    expect(writes).toContain("PATCH releases/12");
  });

  it("rejects a fast-forward record whose original base differs from the reviewed parent", async () => {
    const fastForward = { ...mergedPR, merge_commit_sha: null, created_at: openedAt, merged_at: mergedAt,
      base: { ...mergedPR.base, sha: tree } };
    const { run, writes } = github(call =>
      call === `GET commits/${sha}/pulls` ? json([fastForward]) : call === "GET pulls/7" ? json(fastForward) : undefined);
    await expect(run()).rejects.toThrow("快进合并");
    expect(writes).toEqual([]);
  });

  it.each([true, false])("accepts unlinked historical checks only if completed before the fast-forward (%s)", async beforeMerge => {
    const fastForward = { ...mergedPR, merge_commit_sha: null, created_at: openedAt, merged_at: mergedAt };
    const review = { ...prRun("topbot-automatic-review.yml", 97), pull_requests: [], created_at: openedAt,
      updated_at: beforeMerge ? "2026-11-20T05:40:00Z" : "2026-11-20T07:10:00Z" };
    const { run, writes } = github(call => {
      if (call === `GET commits/${sha}/pulls`) return json([fastForward]);
      if (call === "GET pulls/7") return json(fastForward);
      if (call === "GET actions/workflows/topbot-automatic-review.yml/runs") return json({ total_count: 1, workflow_runs: [review] });
      return undefined;
    });
    if (beforeMerge) {
      await expect(run()).resolves.toBeUndefined();
      expect(writes).toContain("PATCH releases/12");
    } else {
      await expect(run()).rejects.toThrow("No unique TopBot automatic review run");
      expect(writes).toEqual([]);
    }
  });

  it("reserves a new ref and uploads to the returned draft ID before publishing", async () => {
    const gh = github();
    await gh.run();
    expect(gh.writes).toEqual(["POST git/refs", "POST releases", "POST releases/12/assets", "POST releases/12/assets", "PATCH releases/12"]);
    const index = gh.calls.indexOf("PATCH releases/12");
    expect(gh.calls.slice(index - 3, index)).toEqual(["GET actions/runs/98/attempts/1/jobs", `GET git/ref/tags/${tag}`, "GET releases/12"]);
    expect(gh.calls.filter(call => call === "GET immutable-releases")).toHaveLength(2);
  });
  it.each([2, 3])("accepts only a bounded complete exact-SHA CI rerun (attempt %s)", async attempt => {
    const gh = github(call => {
      if (call === "GET actions/workflows/ci.yml/runs") return undefined;
      if (call === "GET actions/runs/98") return json({ ...ci, run_attempt: attempt });
      if (call === "GET actions/runs/98/attempts/2/jobs") {
        return json({ jobs: [{ name: "CI", head_sha: sha, run_id: 98, status: "completed", conclusion: "success" }] });
      }
      return undefined;
    });
    const env = { ...ownerRun, VERIFIED_CI_RUN: "98" };
    if (attempt === 2) {
      await expect(gh.run(env)).resolves.toBeUndefined();
      expect(gh.writes).toContain("PATCH releases/12");
      expect(gh.calls).not.toContain("GET actions/runs/98/attempts/1/jobs");
    } else {
      await expect(gh.run(env)).rejects.toThrow();
      expect(gh.writes).toEqual([]);
    }
  });
  it.each([
    ["unprotected main", "GET branches/main", { protected: false, commit: { sha } }],
    ["a required human approval", "GET rules/branches/main", [...autoPolicy, { type: "pull_request" }]],
    ["no protected review policy", "GET rules/branches/main", []],
    ["mutable releases", "GET immutable-releases", { enabled: false }],
    ["old main SHA", "GET branches/main", { protected: true, commit: { sha: base } }],
    ["wrong snapshot parents", `GET commits/${sha}`, { sha, parents: [{ sha: base }, { sha: base }], commit: { tree: { sha: tree } } }],
    ["automatic review denied", "GET actions/workflows/topbot-automatic-review.yml/runs",
      { total_count: 1, workflow_runs: [{ ...prRun("topbot-automatic-review.yml", 97), conclusion: "failure" }] }],
    ["CI run pending", "GET actions/runs/98/attempts/1/jobs", { jobs: [{ name: "CI", head_sha: sha, status: "in_progress", conclusion: null }] }],
    ["final CI check failed", "GET actions/runs/98/attempts/1/jobs", { jobs: [{ name: "CI", head_sha: sha, status: "completed", conclusion: "failure" }] }],
  ])("refuses %s before reserving the tag", async (_title, path, body) => {
    const gh = github(call => call === path ? json(body) : undefined);
    await expect(gh.run()).rejects.toThrow();
    expect(gh.writes).toEqual([]);
  });
  it("checks for review and CI changes again before publishing", async () => {
    const gh = github((call, count) => call === "GET actions/workflows/topbot-automatic-review.yml/runs" && count === 2
      ? json({ total_count: 1, workflow_runs: [{ ...prRun("topbot-automatic-review.yml", 97), conclusion: "failure" }] }) : undefined);
    await expect(gh.run()).rejects.toThrow(/did not finish successfully/);
    expect(gh.writes).toContain("POST git/refs");
    expect(gh.writes).not.toContain("PATCH releases/12");
  });
  it("will not use the write token for policy inspection", async () => {
    for (const TOPBOT_RELEASE_POLICY_TOKEN of ["", ownerRun.GH_TOKEN]) {
      const gh = github();
      await expect(gh.run({ ...ownerRun, TOPBOT_RELEASE_POLICY_TOKEN })).rejects.toThrow(/separate read-only/);
      expect(gh.calls).toEqual([]);
    }
  });
  it("checks the draft assets again after the final policy reads", async () => {
    const gh = github(call => call === "GET releases/12" ? json({ id: 12, tag_name: tag, draft: true, assets: [] }) : undefined);
    await expect(gh.run()).rejects.toThrow(/assets differ/);
    expect(gh.writes).not.toContain("PATCH releases/12");
  });
  it("accepts a redacted list only with the owner's exact attestation, never over a visible bypass", async () => {
    const { bypass_actors: _redacted, ...redacted } = rule;
    const guard = (detail: unknown) => github(call => call === "GET rulesets/42" ? json(detail) : undefined);
    await guard(redacted).run();
    for (const [detail, attestation] of [[redacted, ""], [{ ...redacted, updated_at: "2026-11-19T20:00:00Z" }, proof],
      [{ ...rule, bypass_actors: [{}] }, proof]] as const) {
      const gh = guard(detail);
      await expect(gh.run({ ...ownerRun, REVIEWED_TAG_RULESET: attestation })).rejects.toThrow(/ruleset/);
      expect(gh.writes).toEqual([]);
    }
  });
  it("compares an owner-entered offset proof against the redacted UTC revision", async () => {
    const { bypass_actors: _redacted, ...redacted } = rule;
    const guard = () => github(call => call === "GET rulesets/42"
      ? json({ ...redacted, updated_at: "2026-11-18T20:00:00.035Z" }) : undefined);
    await guard().run({ ...ownerRun, REVIEWED_TAG_RULESET: "42@2026-11-18T15:00:00.035-05:00" });
    for (const supplied of ["42@2026-11-18T15:00:00.036-05:00", "42@2026-11-18T15:00:00.035+99:00"]) {
      const gh = guard();
      await expect(gh.run({ ...ownerRun, REVIEWED_TAG_RULESET: supplied })).rejects.toThrow(/ruleset/);
      expect(gh.writes).toEqual([]);
    }
  });
  it.each([{ GITHUB_ACTOR: "writer" }, { GITHUB_TRIGGERING_ACTOR: "writer" }, { GITHUB_TRIGGERING_ACTOR: "" },
    { REVIEWED_SHA: sha.toUpperCase() }, { GITHUB_REF: "refs/heads/dev" }, { GITHUB_REPOSITORY: "other/TopBot" }])(
    "rejects unapproved run context %o before contacting GitHub", async change => {
      const gh = github();
      await expect(gh.run({ ...ownerRun, ...change })).rejects.toThrow(/owner/);
      expect(gh.calls).toEqual([]);
    });
  it("checks the local archive, exact file set and reviewed package version before reserving a tag", async () => {
    const gh = github();
    await expect(publishWindowsUpdate(directory, "9.9.9", ownerRun, vi.fn())).rejects.toThrow(/version/);
    await writeFile(join(directory, "extra.zip"), "extra");
    await expect(gh.run()).rejects.toThrow(/only the qualified archive/);
    await rm(join(directory, "extra.zip"));
    await writeFile(join(directory, archive), "changed");
    await expect(gh.run()).rejects.toThrow(/Archive differs/);
    expect(gh.writes).toEqual([]);
  });
  it.each([409, 422, 500])("never adopts an existing tag or retries an ambiguous create (%i)", async status => {
    const gh = github(call => call === "POST git/refs" ? json({}, status) : undefined);
    await expect(gh.run()).rejects.toThrow(`HTTP ${status}`);
    expect(gh.writes).toEqual(["POST git/refs"]);
  });
  it("rejects a same-sized replacement archive on the draft even if both files are present", async () => {
    const body = await readFile(join(directory, manifest));
    const assets = [{ name: archive, state: "uploaded", size: bytes.length, digest: `sha256:${"0".repeat(64)}` },
      { name: manifest, state: "uploaded", size: body.length, digest: `sha256:${digest(body)}` }];
    const gh = github((call, n) => call === "GET releases" && n === 2 ? json([{ id: 12, draft: true, tag_name: tag, assets }]) : undefined);
    await expect(gh.run()).rejects.toThrow(/assets differ/);
    expect(gh.writes).not.toContain("PATCH releases/12");
  });
  it.each([true, false])("refuses an existing release (draft=%s)", async draft => {
    const gh = github(call => call === "GET releases" ? json([{ tag_name: tag, draft, id: 9 }]) : undefined);
    await expect(gh.run()).rejects.toThrow(/already has/);
    expect(gh.writes).toEqual([]);
  });
  it.each<[string, Intercept]>([
    ["wrong SHA at reservation", c => c === "POST git/refs" ? json({ ref: `refs/tags/${tag}`, object: { type: "commit", sha: "b".repeat(40) } }, 201) : undefined],
    ["unexpected ref type", c => c.startsWith("GET git/ref/") ? json({ ref: `refs/tags/${tag}`, object: { type: "tag", sha } }) : undefined],
    ["release lookup failure", c => c === "GET releases" ? json({}, 503) : undefined],
    ["ambiguous draft creation", c => c === "POST releases" ? json({}, 502) : undefined],
    ["upload failure", c => c.endsWith("/assets") ? json({}, 502) : undefined],
    ["competing draft", (c, n) => c === "GET releases" && n === 2 ? json([{ id: 99, draft: true, tag_name: tag }]) : undefined],
    ["incomplete assets", (c, n) => c === "GET releases" && n === 2 ? json([{ id: 12, draft: true, tag_name: tag, assets: [] }]) : undefined],
    ["policy drift", (c, n) => c === "GET rulesets/42" && n === 2 ? json({ ...rule, enforcement: "disabled" }) : undefined],
    ["tag moved before publish", (c, n) => c.startsWith("GET git/ref/") && n === 2 ? json({ ref: `refs/tags/${tag}`, object: { type: "commit", sha: "b".repeat(40) } }) : undefined],
  ])("does not publish or clean up after %s", async (_label, fault) => {
    const gh = github(fault);
    await expect(gh.run()).rejects.toThrow();
    expect(gh.writes.some(call => call.startsWith("PATCH") || call.startsWith("DELETE"))).toBe(false);
  });
  it("never retries or rolls back an ambiguous final publication", async () => {
    const gh = github(call => call === "PATCH releases/12" ? json({}, 503) : undefined);
    await expect(gh.run()).rejects.toThrow("HTTP 503");
    expect(gh.calls.at(-1)).toBe("PATCH releases/12");
    expect(gh.calls.filter(c => c.startsWith("PATCH"))).toHaveLength(1);
  });
});

it("keeps retry authorization on the write job and selects the qualified artifact by ID", async () => {
  const { jobs, on } = parse(await readFile(new URL("../../.github/workflows/topbot-windows-update.yml", import.meta.url), "utf8"));
  expect(on.workflow_dispatch.inputs.reviewed_tag_ruleset.type).toBe("string");
  for (const actor of ["actor", "triggering_actor"]) expect(jobs.publish.if).toContain(`github.${actor} == github.repository_owner`);
  expect(jobs.build.steps[0].run).toContain("GITHUB_TRIGGERING_ACTOR");
  expect(jobs.publish.needs).toBe("build");
  expect(jobs.publish.environment).toBe("topbot-windows-release");
  expect(jobs.publish.permissions).toEqual({ contents: "write", actions: "read", "pull-requests": "read" });
  expect(jobs.publish.if).toContain("needs.build.outputs.artifact_id != ''");
  const steps = jobs.publish.steps as { uses?: string; with?: Record<string, unknown> }[];
  const action = (prefix: string) => steps.find(s => s.uses?.startsWith(`actions/${prefix}@`))?.with;
  expect(action("checkout")).toMatchObject({ ref: "${{ github.sha }}", "persist-credentials": false, path: "source" });
  expect(action("setup-node")?.["node-version"]).toBe(24);
  expect(action("download-artifact")).toEqual({ "artifact-ids": "${{ needs.build.outputs.artifact_id }}", "digest-mismatch": "error", path: "release" });
  expect(jobs.build.outputs.artifact_id).toBe("${{ steps.artifact.outputs.artifact-id }}");
  expect(jobs.publish.steps.at(-1)).toMatchObject({ run: "node source/scripts/publish-topbot-windows.mjs release",
    env: { REVIEWED_TAG_RULESET: "${{ inputs.reviewed_tag_ruleset }}", REVIEWED_SHA: "${{ inputs.reviewed_sha }}",
      TOPBOT_RELEASE_POLICY_TOKEN: "${{ secrets.TOPBOT_RELEASE_POLICY_TOKEN }}" } });
});

it("gives this fork one automated release writer, including tag and manual triggers", async () => {
  const jobsFor = async (file: string) => parse(await readFile(new URL(`../../.github/workflows/${file}`, import.meta.url), "utf8")).jobs;
  const upstream = await jobsFor("release.yml");
  expect(upstream.prepare.if).toBe("github.repository != 'topway-ai/TopBot-Iteration-Lab'");
  for (const [name, job] of Object.entries(upstream) as [string, { if?: string }][]) {
    if (name !== "prepare") expect(job.if).toContain("needs.prepare.outputs.should_release == 'true'");
  }
  const npm = await jobsFor("npm-package.yml");
  for (const [name, job] of Object.entries(npm) as [string, { if?: string }][]) {
    if (name !== "pack-and-prove") expect(job.if).toMatch(/^github\.repository != 'topway-ai\/TopBot-Iteration-Lab' &&/);
  }
  expect((await jobsFor("sync-published-release.yml")).mirror.if).toMatch(/^github\.repository != 'topway-ai\/TopBot-Iteration-Lab' && \(/);
  for (const [workflow, job] of [["docker.yml", "publish"], ["connector-release.yml", "publish"], ["promote-stable.yml", "promote"], ["ci.yml", "deploy-composio-broker"]]) {
    expect((await jobsFor(workflow))[job].if).toMatch(/^github\.repository != 'topway-ai\/TopBot-Iteration-Lab'(?: &&|$)/);
  }
});
