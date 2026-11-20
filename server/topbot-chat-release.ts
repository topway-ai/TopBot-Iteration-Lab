import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { TopBotReleaseGateError, verifyWindowsReleaseGate } from "../scripts/topbot-release-gate.mjs";
import { resolveTagRulesetProof } from "../scripts/topbot-tag-ruleset.mjs";

const owner = "topway-ai";
const repository = `${owner}/TopBot-Iteration-Lab`;
const repo = `/repos/${repository}`;
const release = "topbot-windows-update.yml";
const project = `https://github.com/${repository}`;
const repositoryId = "R_kgDOV1Ci8g";
const lifetime = 5 * 60_000;
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const objectRef = z.object({ sha });
const branch = z.object({ ref: z.string(), repo: z.object({ full_name: z.literal(repository), node_id: z.literal(repositoryId) }) });
const pull = z.object({ node_id: z.string(), number: z.number().int(), state: z.literal("closed"), draft: z.literal(false),
  merged: z.literal(true), merge_commit_sha: sha, base: branch, head: branch.extend({ sha }), changed_files: z.number().int().min(2).max(100) });
const sourceFile = z.object({ filename: z.string(), previous_filename: z.string().optional(), status: z.string(), additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative() });
const singleChild = objectRef.extend({ parents: z.array(objectRef).length(1), commit: z.object({ tree: objectRef }) });
const compare = z.object({ merge_base_commit: objectRef, commits: z.array(singleChild).length(1), ahead_by: z.literal(1), files: z.array(sourceFile).max(100) });
const versionPattern = /^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})-topbot\.(0|[1-9]\d{0,7})$/;
const notesDir = "topbot-release-notes";
const safePath = /^topbot-release-notes\/[a-z0-9][a-z0-9-]{0,39}\.txt$/;
const safeStatus = new Set(["added", "modified", "removed"]);

type Read = (path: string) => Promise<unknown>;
type Request = (path: string, method?: "POST", body?: unknown) => Promise<unknown>;
type Candidate = { id: string; branch: string; gate: Awaited<ReturnType<typeof verifyWindowsReleaseGate>>; version: string; tagProof: string; files: string[] };
type Approval = { threadId: string; code: string; until: number; candidate: Candidate };
export type ChatReleaseCommand = { kind: "prepare"; pr: number } | { kind: "publish"; code: string } | { kind: "help" };
export type ChatReleaseHandler = (threadId: string, command: ChatReleaseCommand) => Promise<string>;

export function chatReleaseCommand(text: string): ChatReleaseCommand | null {
  if (!/^\/topbot-(?:release|publish)(?:\s|$)/i.test(text)) return null;
  const pr = /^\/topbot-release ([1-9]\d{0,8})$/.exec(text);
  const code = /^\/topbot-publish ([a-f0-9]{16})$/.exec(text);
  return pr ? { kind: "prepare", pr: Number(pr[1]) } : code ? { kind: "publish", code: code[1] } : { kind: "help" };
}

class ReleaseRefusal extends Error {}
class GitHubRejection extends ReleaseRefusal {
  readonly status: number;
  constructor(status: number) {
    super(`GitHub 拒绝请求（HTTP ${status}）。`);
    this.status = status;
  }
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ReleaseRefusal(message);
}

function newer(version: string, than: string): boolean {
  const a = versionPattern.exec(version), b = versionPattern.exec(than);
  if (!a || !b) return false;
  for (let i = 1; i <= 4; i++) if (a[i] !== b[i]) return Number(a[i]) > Number(b[i]);
  return false;
}

async function packageAt(request: Read, commit: string) {
  const data = z.object({ encoding: z.literal("base64"), content: z.string().max(400_000), size: z.number().max(256_000), type: z.literal("file") })
    .parse(await request(`${repo}/contents/package.json?ref=${commit}`));
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.from(data.content, "base64"));
  return { version: z.object({ version: z.string() }).parse(JSON.parse(text)).version, text };
}

async function verifyFileModes(request: Read, tree: string, files: z.infer<typeof sourceFile>[]) {
  const entries = async (id: string) => z.object({ sha: z.literal(id), truncated: z.literal(false), tree:
    z.array(z.object({ path: z.string(), mode: z.string(), type: z.string(), sha })) }).parse(await request(`${repo}/git/trees/${id}`)).tree;
  const root = await entries(tree);
  requireCondition(root.some((e) => e.path === "package.json" && e.mode === "100644" && e.type === "blob"), "package.json 必须是普通文件。");
  const changedNotes = files.filter((file) => file.filename !== "package.json" && file.status !== "removed");
  if (!changedNotes.length) return;
  const directory = root.find((e) => e.path === notesDir && e.mode === "040000" && e.type === "tree");
  requireCondition(directory, "发布说明目录必须是普通 Git 目录。");
  const notes = await entries(directory.sha);
  requireCondition(changedNotes.every((file) => notes.some((e) => e.path === file.filename.slice(notesDir.length + 1) &&
    e.mode === "100644" && e.type === "blob")), "发布说明必须是普通的不可执行文件。");
}

async function inspect(request: Read, number: number, installed: string, verifyGate: typeof verifyWindowsReleaseGate): Promise<Candidate> {
  const pr = pull.parse(await request(`${repo}/pulls/${number}`));
  requireCondition(pr.number === number && pr.base.ref === "main" && /^topbot-auto\/[a-z0-9][a-z0-9-]{0,39}$/.test(pr.head.ref),
    "只接受 TopBot 仓库内、由开发流程提交到 main 的 PR。");
  const gate = await verifyGate(request, pr.merge_commit_sha, number);
  const { base, head, tree } = gate;
  requireCondition(gate.pullRequest === number && gate.sha === pr.merge_commit_sha && head === pr.head.sha,
    "指定 PR 与经过审核的合并提交不一致。");
  const diff = compare.parse(await request(`${repo}/compare/${base}...${head}?per_page=1`));
  requireCondition(diff.merge_base_commit.sha === base && diff.files.length === pr.changed_files &&
    diff.commits[0]?.sha === head && diff.commits[0].parents[0]?.sha === base && diff.commits[0].commit.tree.sha === tree,
    "PR 必须是合并前 main 的单一子提交，与合并代码树一致，且 GitHub 必须返回完整的文件清单。");
  const protectedFiles = diff.files.filter((file) => file.previous_filename || !safeStatus.has(file.status) ||
    !(file.filename === "package.json" ? file.status === "modified" : safePath.test(file.filename)));
  requireCondition(protectedFiles.length === 0,
    "这个 PR 不属于聊天自动发布范围。更新器、权限、工作流、程序代码及其他高风险路径须走独立发布流程。");
  requireCondition(diff.files.some((file) => file.filename === "package.json"), "请先在 PR 中递增 TopBot 版本号。");
  await verifyFileModes(request, tree, diff.files);
  requireCondition(diff.files.reduce((lines, file) => lines + file.additions + file.deletions, 0) <= 3000,
    "改动量超过聊天发布上限，请拆成小 PR 或独立审核。");
  const [before, after, versions] = await Promise.all([
    packageAt(request, base), packageAt(request, head),
    request(`${repo}/releases?per_page=20`),
  ]);
  requireCondition(before.text.replace(/("version"\s*:\s*)"[^"\\]*"/, (_, prefix) => prefix + JSON.stringify(after.version)) === after.text,
    "package.json 除了版本号还有其他改动，需要独立审核。");
  requireCondition(newer(after.version, before.version) && newer(after.version, installed), "候选版本必须高于合并前的 main 和本机版本。");
  const history = z.array(z.object({ tag_name: z.string(), draft: z.boolean(), prerelease: z.boolean() })).parse(versions);
  requireCondition(history.every((entry) => {
    const published = entry.tag_name.slice(1);
    return entry.draft || entry.prerelease || !entry.tag_name.startsWith("v") || !versionPattern.test(published) || newer(after.version, published);
  }), "候选版本不能低于或等于已发布的 TopBot 版本。");
  for (const endpoint of [`releases/tags/v${after.version}`, `git/ref/tags/v${after.version}`]) {
    let available = false;
    try { await request(`${repo}/${endpoint}`); }
    catch (error) { if (error instanceof GitHubRejection && error.status === 404) available = true; else throw error; }
    requireCondition(available, "这个版本的 Release 或标签已经存在，请递增版本号。");
  }
  const tagProof = await resolveTagRulesetProof(request, `v${after.version}`);
  requireCondition(tagProof, "无法验证不可修改、不可删除且无绕过者的版本标签规则。");
  return { id: pr.node_id, branch: pr.head.ref, gate, version: after.version, tagProof, files: diff.files.map((file) => file.filename).sort() };
}

async function credential(): Promise<string> {
  const home = homedir();
  let executable = "git";
  try {
    const config = z.object({ gitExecutable: z.string().refine(isAbsolute).optional() }).parse(
      JSON.parse(await readFile(join(home, ".topbot-development", "config.json"), "utf8")),
    );
    executable = config.gitExecutable ?? executable;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new ReleaseRefusal("TopBot 开发配置不可读，或 Git 路径不是绝对路径。请检查本机配置后重试。");
    }
  }
  return new Promise((resolve, reject) => {
    const child = execFile(executable, ["-c", "credential.interactive=false", "credential", "fill"], {
      cwd: home, timeout: 8_000, windowsHide: true, maxBuffer: 32_768,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" },
    }, (error, output) => {
      const token = !error && /^password=(\S+)\r?$/m.exec(output)?.[1];
      if (token) resolve(token);
      else reject(new ReleaseRefusal("Windows 没有可用的 TopBot GitHub 授权。请在聊天之外登录 GitHub，不要发送密钥。"));
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(`protocol=https\nhost=github.com\npath=${repository}.git\nusername=${owner}\n\n`);
  });
}

export async function connectChatRelease(request: typeof fetch = fetch, cachedCredential = credential): Promise<Request> {
  const token = await cachedCredential();
  const call: Request = async (path, method, body) => {
    const response = await request(`https://api.github.com${path}`, { method: method ?? "GET", redirect: "error",
      signal: AbortSignal.timeout(8_000), headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json",
        "content-type": "application/json", "user-agent": "TopBot-Chat-Release", "x-github-api-version": "2022-11-28" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) { await response.body?.cancel(); throw new GitHubRejection(response.status); }
    return response.status === 204 ? undefined : response.json();
  };
  const user = z.object({ login: z.string() }).parse(await call("/user"));
  requireCondition(user.login.toLowerCase() === owner, "当前 GitHub 登录不是 TopBot 仓库所有者，已停止。");
  return call;
}

export function createTopBotChatRelease({ installedVersion, connect = connectChatRelease, verifyGate = verifyWindowsReleaseGate, now = Date.now,
  eligible = () => true, randomCode = () => randomBytes(8).toString("hex") }: {
  installedVersion: () => string; connect?: () => Promise<Request>; verifyGate?: typeof verifyWindowsReleaseGate;
  now?: () => number; eligible?: () => boolean; randomCode?: () => string;
}): ChatReleaseHandler {
  let pending: Approval | undefined;
  let busy = false;
  return async (threadId, command) => {
    if (command.kind === "help") return "请单独发送 `/topbot-release PR编号` 查看发布预览，或发送预览中给出的确认命令。";
    if (busy) return "另一个发布操作正在处理，请等待结果。";
    if (!eligible()) return "TopBot 还有任务在运行。请等任务结束后再确认发布。";
    if (pending && pending.until <= now()) pending = undefined;
    const approved = pending;
    if (command.kind === "publish" && (!approved || approved.threadId !== threadId || approved.code !== command.code)) {
      return "这条确认无效、已使用或已过期。请在原对话中重新生成发布预览。";
    }
    busy = true;
    pending = undefined;
    let dispatchAttempted = false;
    try {
      const request = await connect();
      const number = command.kind === "prepare" ? command.pr : approved!.candidate.gate.pullRequest;
      const candidate = await inspect((path) => request(path), number, installedVersion(), verifyGate);
      const { version, gate } = candidate;
      const { pullRequest: pr, head, base, sha: merged, ciRun, ciAttempt } = gate;
      if (command.kind === "prepare") {
        const code = randomCode();
        pending = { threadId, code, until: now() + lifetime, candidate };
        const listed = candidate.files.slice(0, 10).map((file) => `- \`${file}\``).join("\n");
        return [`**正式发布预览：TopBot ${version}**`, `[查看 PR #${pr} 的完整改动](${project}/pull/${pr}/files) · ${candidate.files.length} 个文件`,
          `受保护 main 的提交：\`${merged}\``, `经过自动审核的提交：\`${head}\``, `更新前的 main：\`${base}\``,
          `[完整 CI](${project}/actions/runs/${ciRun}/attempts/${ciAttempt}) 已通过。`,
          `改动文件${candidate.files.length > 10 ? "（前 10 项）" : ""}：\n${listed}`,
          `确认仅授权为上述合并提交启动发布工作流，不会合并 PR 或修改分支。仅在这个聊天内发送 \`/topbot-publish ${code}\`，5 分钟内有效、只能用一次。`].join("\n\n");
      }
      const main = z.object({ protected: z.boolean(), commit: objectRef }).parse(await request(`${repo}/branches/main`));
      requireCondition(main.protected && main.commit.sha === merged, "受保护的 main 已变化，请重新预览。");
      requireCondition(approved!.until > now() && isDeepStrictEqual(approved!.candidate, candidate), "预览已过期，或 PR、main、检查结果已变动。请重新预览。");
      requireCondition(eligible(), "等待当前任务结束后重新预览。");
      // The workflow rejects a main tip change between this read and GitHub resolving the dispatch ref.
      dispatchAttempted = true;
      await request(`${repo}/actions/workflows/${release}/dispatches`, "POST", { ref: "main", inputs: { publish: "true", reviewed_sha: merged, reviewed_tag_ruleset: candidate.tagProof } });
      return `**TopBot ${version} 已进入发布队列，尚未正式发布。**\n\n目标为 PR #${pr} 在受保护 main 上的合并提交 \`${merged}\`。GitHub 验证通过才发布。[查看发布进度](${project}/actions/workflows/${release})。安装和回滚由现有更新器处理。`;
    } catch (error) {
      const reason = error instanceof ReleaseRefusal || error instanceof TopBotReleaseGateError ? error.message : "未能核对 GitHub 返回的状态。";
      if (!dispatchAttempted) return `未触发发布。${reason}`;
      return `${reason}确认已消耗，不会自动重试；请核对 [GitHub Actions](${project}/actions/workflows/${release}) 的发布状态。`;
    } finally {
      busy = false;
    }
  };
}
