import { describe, expect, it, vi } from "vitest";
import { TopBotReleaseGateError, type verifyWindowsReleaseGate } from "../scripts/topbot-release-gate.mjs";
import { chatReleaseCommand, connectChatRelease, createTopBotChatRelease } from "./topbot-chat-release.ts";

const repo = "/repos/topway-ai/TopBot-Iteration-Lab";
const base = "a".repeat(40), head = "b".repeat(40), merged = "c".repeat(40), moved = "d".repeat(40);
const tree = "e".repeat(40), notes = "f".repeat(40);
const gate = { pullRequest: 7, base, head, sha: merged, tree, ciRun: 54, ciAttempt: 2, approval: 102 };
const dispatch = `${repo}/actions/workflows/topbot-windows-update.yml/dispatches`;
const code = "0123456789abcdef";
const prepare = { kind: "prepare", pr: 7 } as const;
const confirm = { kind: "publish", code } as const;
const packageFile = (version: string, scripts = {}) => ({ type: "file", encoding: "base64", size: 100,
  content: Buffer.from(JSON.stringify({ name: "topbot", version, scripts })).toString("base64") });

function fixture() {
  const mutations: Array<[string, string, unknown]> = [];
  const state = { time: 0, idle: true, draft: false, prState: "closed", prMerged: true, mergeSha: merged, prHead: head, gate: { ...gate }, gateError: "",
    file: "topbot-release-notes/layout.txt", mode: "100644", packageMode: "100644", previous: undefined as string | undefined, changedFiles: 2, additions: 5,
    main: merged, protected: true, mainAfterGate: "", unprotectAfterGate: false, parent: base, compareTree: tree, baseRef: "main", headRef: "topbot-auto/layout",
    unknownDispatch: false, user: "topway-ai", metadata: {}, version: "0.1.161-topbot.9", lastRelease: "v0.1.161-topbot.6", missingVersion: true,
    ruleset: true, headRepoId: "R_kgDOV1Ci8g", updatedAt: "2026-11-18T20:00:00Z" };
  const read = (path: string) => {
    if (path === "/user") return { login: state.user };
    if (path.startsWith(`${repo}/rulesets?`)) return state.ruleset ? [{ id: 12, enforcement: "active" }] : [];
    if (path === `${repo}/rulesets/12`) {
      if (state.mainAfterGate) state.main = state.mainAfterGate;
      if (state.unprotectAfterGate) state.protected = false;
      return { id: 12, source_type: "Repository", source: "topway-ai/TopBot-Iteration-Lab", updated_at: state.updatedAt,
        target: "tag", enforcement: "active", bypass_actors: [], conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } }, rules: [{ type: "update" }, { type: "deletion" }] };
    }
    if (path === `${repo}/pulls/7`) return { node_id: "pr7", number: 7, state: state.prState, draft: state.draft, merged: state.prMerged,
      merge_commit_sha: state.mergeSha, changed_files: state.changedFiles,
      base: { ref: state.baseRef, sha: state.main, repo: { full_name: "topway-ai/TopBot-Iteration-Lab", node_id: "R_kgDOV1Ci8g" } },
      head: { ref: state.headRef, sha: state.prHead, repo: { full_name: "topway-ai/TopBot-Iteration-Lab", node_id: state.headRepoId } } };
    if (path === `${repo}/branches/main`) return { commit: { sha: state.main }, protected: state.protected };
    if (path === `${repo}/compare/${base}...${head}?per_page=1`) return { merge_base_commit: { sha: base }, ahead_by: 1,
      commits: [{ sha: head, parents: [{ sha: state.parent }], commit: { tree: { sha: state.compareTree } } }], files: [
      { filename: "package.json", status: "modified", additions: 1, deletions: 1 },
      { filename: state.file, previous_filename: state.previous, status: "modified", additions: state.additions, deletions: 3 },
    ] };
    if (path === `${repo}/contents/package.json?ref=${base}`) return packageFile("0.1.161-topbot.8");
    if (path === `${repo}/git/trees/${tree}`) return { sha: tree, truncated: false, tree: [
      { path: "package.json", mode: state.packageMode, type: "blob", sha: head }, { path: "topbot-release-notes", mode: "040000", type: "tree", sha: notes },
    ] };
    if (path === `${repo}/git/trees/${notes}`) return { sha: notes, truncated: false, tree: [
      { path: "layout.txt", mode: state.mode, type: "blob", sha: head },
    ] };
    if (path === `${repo}/contents/package.json?ref=${head}`) return packageFile(state.version, state.metadata);
    if (path === `${repo}/releases?per_page=20`) return [{ tag_name: state.lastRelease, draft: false, prerelease: false }];
    if (path === `${repo}/releases/tags/v${state.version}` || path === `${repo}/git/ref/tags/v${state.version}`) return state.missingVersion ? undefined : {};
    throw new Error(`Unexpected GitHub request: ${path}`);
  };
  const request = vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toMatch(/^https:\/\/api\.github\.com\//);
    expect(init?.redirect).toBe("error");
    const path = String(url).slice("https://api.github.com".length);
    if (init?.method === "GET") {
      const data = read(path);
      return data === undefined ? new Response(null, { status: 404 }) : Response.json(data);
    }
    mutations.push([path, init?.method ?? "", JSON.parse(String(init?.body))]);
    if (path === dispatch) {
      if (state.unknownDispatch) throw new Error("unknown transport state (never show raw errors)");
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected GitHub mutation: ${path}`);
  });
  const verifyGate = vi.fn<typeof verifyWindowsReleaseGate>(async (read, sha) => {
    const main = await read(`${repo}/branches/main`) as { protected: boolean; commit: { sha: string } };
    if (!main.protected || main.commit.sha !== sha || state.gateError) {
      throw new TopBotReleaseGateError(state.gateError || "当前受保护的 main 与待发布提交不一致。");
    }
    return { ...state.gate };
  });
  const run = createTopBotChatRelease({ installedVersion: () => "0.1.161-topbot.8", connect: () => connectChatRelease(request, async () => "synthetic"),
    verifyGate, now: () => state.time, eligible: () => state.idle, randomCode: () => code });
  return { run, state, mutations, request, verifyGate };
}

describe("TopBot formal release from desktop chat", () => {
  it("takes only explicit release commands and treats malformed commands as help", () => {
    expect(chatReleaseCommand("confirm release")).toBeNull();
    expect(chatReleaseCommand("/topbot-release 7")).toEqual(prepare);
    expect(chatReleaseCommand(`/topbot-publish ${code}`)).toEqual(confirm);
    expect(chatReleaseCommand("/topbot-release 7\nhello")).toEqual({ kind: "help" });
  });

  it("previews without mutation and dispatches the exact merged main SHA once", async () => {
    const f = fixture();
    const preview = await f.run("chat", prepare);
    expect(preview).toContain(merged);
    expect(preview).toContain(head);
    expect(preview).toContain(base);
    expect(preview).toContain("/actions/runs/54/attempts/2");
    expect(preview).toContain("0.1.161-topbot.9");
    expect(preview).toContain("topbot-release-notes/layout.txt");
    expect(preview).toContain(`/topbot-publish ${code}`);
    expect(f.mutations).toEqual([]);
    expect(f.verifyGate).toHaveBeenCalledExactlyOnceWith(expect.any(Function), merged, 7);
    expect(await f.run("other-chat", confirm)).toContain("无效");
    const messages = await Promise.all([f.run("chat", confirm), f.run("chat", confirm)]);
    expect(messages[0]).toContain("尚未正式发布");
    expect(messages[1]).toContain("正在处理");
    expect(f.verifyGate).toHaveBeenCalledTimes(2);
    expect(f.verifyGate).toHaveBeenLastCalledWith(expect.any(Function), merged, 7);
    expect(f.request.mock.calls.at(-2)?.[0]).toBe(`https://api.github.com${repo}/branches/main`);
    expect(f.mutations).toEqual([
      [dispatch, "POST", { ref: "main", inputs: { publish: "true", reviewed_sha: merged, reviewed_tag_ruleset: "12@2026-11-18T20:00:00Z" } }],
    ]);
    expect(await f.run("chat", confirm)).toContain("无效");
  });

  it.each([
    { time: 300_000 }, { prHead: moved }, { main: moved }, { draft: true }, { protected: false }, { baseRef: "other" },
    { mergeSha: moved, main: moved, gate: { ...gate, sha: moved } }, { headRef: "topbot-auto/other" },
    { gate: { ...gate, approval: 103 } }, { gate: { ...gate, ciRun: 55 } }, { gate: { ...gate, ciAttempt: 3 } },
    { ruleset: false }, { updatedAt: "2026-11-18T20:01:00Z" },
  ])("does not mutate if confirmation became stale: %o", async (change) => {
    const f = fixture();
    await f.run("chat", prepare);
    Object.assign(f.state, change);
    expect(await f.run("chat", confirm)).not.toContain("已进入发布队列");
    expect(f.mutations).toEqual([]);
  });

  it.each([
    { prState: "open", prMerged: false }, { prMerged: false }, { mergeSha: null }, { main: moved }, { protected: false },
    { headRef: "other/layout" }, { headRepoId: "different-repository" }, { gate: { ...gate, pullRequest: 8 } },
    { parent: moved }, { compareTree: moved }, { changedFiles: 3 },
    { file: ".github/workflows/topbot-windows-update.yml" }, { file: "electron/main.mjs" }, { file: "server/request-auth.ts" },
    { file: "docs/example.md" }, { mode: "120000" }, { mode: "100755" }, { packageMode: "100755" }, { additions: 3000 },
    { previous: "electron/main.mjs" }, { metadata: { prepare: "changed" } }, { version: "0.1.161-topbot.8" },
    { missingVersion: false }, { user: "someone-else" }, { idle: false }, { lastRelease: "v0.1.161-topbot.10" },
  ])("does not offer confirmation for ineligible PRs: %o", async (change) => {
    const f = fixture();
    Object.assign(f.state, change);
    expect(await f.run("chat", prepare)).not.toContain(`/topbot-publish ${code}`);
    expect(await f.run("chat", confirm)).not.toContain("已进入发布队列");
    expect(f.mutations).toEqual([]);
  });

  it.each(["缺少有效的独立审核。", "确切 main 提交的完整 CI 尚未通过。"])("fails closed when the shared gate refuses: %s", async (gateError) => {
    const f = fixture();
    f.state.gateError = gateError;
    const refused = await f.run("chat", prepare);
    expect(refused).toContain(gateError);
    expect(refused).not.toContain(`/topbot-publish ${code}`);
    f.state.gateError = "";
    await f.run("chat", prepare);
    f.state.gateError = gateError;
    expect(await f.run("chat", confirm)).toContain(gateError);
    expect(await f.run("chat", confirm)).toContain("无效");
    expect(f.mutations).toEqual([]);
  });

  it.each([{ mainAfterGate: moved }, { unprotectAfterGate: true }])("refuses a change to protected main after the gate: %o", async (change) => {
    const f = fixture();
    await f.run("chat", prepare);
    Object.assign(f.state, change);
    expect(await f.run("chat", confirm)).toContain("受保护的 main 已变化");
    expect(f.mutations).toEqual([]);
  });

  it("does not expose raw errors or retry a dispatch with an ambiguous outcome", async () => {
    const f = fixture();
    f.state.unknownDispatch = true;
    await f.run("chat", prepare);
    const report = await f.run("chat", confirm);
    expect(report).toContain("不会自动重试");
    expect(report).not.toContain("unknown transport state");
    expect(await f.run("chat", confirm)).toContain("无效");
    expect(f.mutations.map(([path]) => path)).toEqual([dispatch]);
  });
});
