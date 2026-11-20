import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, rmdir } from "node:fs/promises";
import { constants, homedir, setPriority } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { gitAt, runDevelopment } from "./topbot-development.mjs";
import { advanceAutomaticMain, AutomaticCheckPending, requireAutomaticMain, verifyAutomaticCandidate } from "./topbot-auto-github.mjs";
import { verifyWindowsReleaseGate, TopBotReleaseGateError } from "./topbot-release-gate.mjs";
import { resolveTagRulesetProof } from "./topbot-tag-ruleset.mjs";
import { editWithDeepSeek, editWithLocalQwen } from "./topbot-iteration-editor.mjs";
import { publishQualifiedWindowsArchive, releaseAssets } from "./publish-topbot-windows.mjs";
import { downloadQualification, qualificationDownloadUrl } from "./topbot-qualification-artifact.mjs";

const repository = "topway-ai/TopBot-Iteration-Lab";
const repo = `/repos/${repository}`;
const sha = /^[a-f0-9]{40}$/;
const topbotVersion = /^(?:0|[1-9]\d{0,7})\.(?:0|[1-9]\d{0,7})\.(?:0|[1-9]\d{0,7})-topbot\.(?:0|[1-9]\d{0,7})$/;
const workflow = (name) => `${repo}/actions/workflows/${name}.yml/dispatches`;
const automationFiles = [".github/workflows/topbot-automatic-review.yml", "scripts/topbot-auto-review.mjs"];
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export const validIterationTask = value => typeof value === "string" && value.trim().length > 0 &&
  value.length <= 4000 && !/[^\P{Cc}\t\n\r]/u.test(value);

export class IterationGitHubError extends Error {
  constructor(status) { super(`GitHub request failed (HTTP ${status}).`); this.status = status; }
}

function requireState(condition, text) {
  if (!condition) throw new Error(text);
}

async function until(check, duration, { now, sleep }) {
  const end = now() + duration;
  do {
    try { return await check(); }
    catch (error) { if (!(error instanceof AutomaticCheckPending)) throw error; }
    if (now() >= end) break;
    await sleep(Math.min(end - now(), 15_000));
  } while (now() <= end);
  throw new Error("Timed out waiting for CI or publication. No write will be retried automatically.");
}

async function dispatchAndWait(request, name, branch, commit, inputs, clock, duration) {
  const started = await request(workflow(name), "POST", { ref: branch, ...(inputs ? { inputs } : {}) });
  const id = started?.workflow_run_id;
  requireState(Number.isSafeInteger(id) && id > 0, "GitHub did not return a workflow run ID; not retrying dispatch.");
  return until(async () => {
    let run;
    try { run = await request(`${repo}/actions/runs/${id}`); }
    catch (error) { if (error instanceof IterationGitHubError && error.status === 404) throw new AutomaticCheckPending(); throw error; }
    requireState(run?.id === id && run.event === "workflow_dispatch" && run.head_sha === commit && run.head_branch === branch &&
      run.head_repository?.full_name === repository && run.path?.split("@", 1)[0] === `.github/workflows/${name}.yml` &&
      run.run_attempt === 1, "Dispatched workflow does not match the expected commit.");
    if (run.status !== "completed") throw new AutomaticCheckPending();
    requireState(run.conclusion === "success", `${name} did not complete successfully.`);
    const stageJob = name === "ci" ? "CI" : inputs?.publish === "true" ? "publish" : "build";
    const result = await request(`${repo}/actions/runs/${id}/attempts/1/jobs?per_page=100`);
    requireState(Array.isArray(result?.jobs) && result.jobs.some(job => job.name === stageJob && job.head_sha === commit &&
      job.run_id === id && job.status === "completed" && job.conclusion === "success"), "The exact workflow job did not succeed.");
    return id;
  }, duration, clock);
}

function versionAt(read, commit) {
  return read(`${repo}/contents/package.json?ref=${commit}`).then(file => {
    requireState(file?.type === "file" && file.encoding === "base64" && typeof file.content === "string" &&
      file.content.length < 350_000, "Cannot verify release version.");
    const { version } = JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
    requireState(typeof version === "string" && topbotVersion.test(version), "Invalid TopBot release version.");
    return version;
  });
}

const versionParts = (value) => value.split(/[.-]/).filter(piece => piece !== "topbot").map(Number);
function newerThan(candidate, previous) {
  const left = versionParts(candidate), right = versionParts(previous);
  const first = left.findIndex((part, i) => part !== right[i]);
  return first >= 0 && left[first] > right[first];
}

export async function iterateTopBot(task, { develop, edit, request, report = () => {}, now = Date.now, sleep = wait,
  slug = `iterate-${randomBytes(8).toString("hex")}`, verify = verifyWindowsReleaseGate, preparePublication }) {
  requireState(validIterationTask(task), "Submit a nonempty task of at most 4000 characters.");
  const read = path => request(path);
  const main = await read(`${repo}/branches/main`);
  const base = main?.commit?.sha;
  requireState(typeof base === "string" && sha.test(base), "Cannot resolve main.");
  await requireAutomaticMain(read, base);
  for (const file of automationFiles) {
    const present = await read(`${repo}/contents/${file}?ref=${base}`);
    requireState(present?.type === "file" && present.path === file, "Trusted automatic review has not been installed on main.");
  }
  const before = await versionAt(read, base);
  let candidate, version, tag, finished = false;
  const job = await develop(["start-auto", slug]);
  try {
    requireState(job.base === base && isAbsolute(job.path), "Development checkout does not match protected main.");
    report("editing");
    await edit({ ...job, task, version: before });
    report("reviewing");
    const receipt = await develop(["candidate"]);
    candidate = { pr: receipt.pr, base: receipt.base, head: receipt.head, branch: receipt.branch };
    requireState(candidate.base === base && sha.test(candidate.head) && Number.isSafeInteger(candidate.pr) && candidate.pr > 0 &&
      candidate.branch === `topbot-auto/${slug}`, "Unexpected automatic candidate receipt.");
    version = await versionAt(read, candidate.head);
    requireState(newerThan(version, before), "An automatic release needs a higher version.");
    tag = `v${version}`;
    for (const endpoint of [`${repo}/git/ref/tags/${tag}`, `${repo}/releases/tags/${tag}`]) {
      try { await read(endpoint); }
      catch (error) { if (error instanceof IterationGitHubError && error.status === 404) continue; throw error; }
      throw new Error("The proposed version already exists on GitHub.");
    }
    await develop(["finish"]);
    finished = true;
  } finally {
    if (!finished) await develop(["retire-auto", slug]).catch(() => {});
  }
  report("testing", { pr: candidate.pr, sha: candidate.head });
  const clock = { now, sleep };
  await until(() => verifyAutomaticCandidate(read, candidate), 30 * 60_000, clock);
  report("full-ci", { sha: candidate.head });
  const ciRun = await dispatchAndWait(request, "ci", candidate.branch, candidate.head, undefined, clock, 60 * 60_000);
  report("qualification", { sha: candidate.head });
  const buildRun = await dispatchAndWait(request, "topbot-windows-update", candidate.branch, candidate.head,
    { publish: "false", reviewed_sha: candidate.head }, clock, 65 * 60_000);
  const promote = async (publish) => {
    const tagProof = await resolveTagRulesetProof(read, tag);
    requireState(tagProof, "No matching immutable version-tag rule.");
    const merged = await advanceAutomaticMain(request, candidate);
    requireState(merged === candidate.head, "Verified automatic main update did not match the candidate.");
    await until(async () => {
      try { return await verify(read, merged, candidate.pr, ciRun); }
      catch (error) {
        if (error instanceof TopBotReleaseGateError && error.retryable === true) throw new AutomaticCheckPending();
        throw error;
      }
    }, 120_000, clock);
    await requireAutomaticMain(read, merged);
    report("publishing", { version, sha: merged });
    if (publish) await publish({ sha: merged, verifiedRun: ciRun, requestedProof: tagProof });
    else await dispatchAndWait(request, "topbot-windows-update", "main", merged,
      { publish: "true", reviewed_sha: merged, reviewed_tag_ruleset: tagProof, verified_ci_run: String(ciRun) }, clock, 65 * 60_000);
  };
  if (preparePublication) await preparePublication({ run: buildRun, head: candidate.head, branch: candidate.branch, version }, promote);
  else await promote();
  const merged = candidate.head;
  return until(async () => {
    let release;
    try { release = await read(`${repo}/releases/tags/${tag}`); }
    catch (error) {
      if (!(error instanceof IterationGitHubError) || error.status !== 404) throw error;
      throw new AutomaticCheckPending();
    }
    if (release?.draft === true) throw new AutomaticCheckPending();
    requireState(release?.tag_name === tag && release.immutable === true && release.prerelease === false &&
      Array.isArray(release.assets) && release.assets.some(a => a.name === "topbot-windows-update.json") &&
      release.assets.some(a => a.name === `TopBot-${version}-x64.zip`), "Published release does not match the qualified commit and assets.");
    const ref = await read(`${repo}/git/ref/tags/${tag}`);
    requireState(ref?.ref === `refs/tags/${tag}` && ref.object?.sha === merged && ref.object.type === "commit", "Release tag points to a different commit.");
    return { version, sha: merged, pr: candidate.pr, url: `https://github.com/${repository}/releases/tag/${tag}` };
  }, 120_000, clock);
}

async function editInSandbox(config, job) {
  requireState(typeof config.workerExecutable === "string" && isAbsolute(config.workerExecutable), "An isolated development worker is required.");
  const envKeys = /^(?:SYSTEMROOT|WINDIR|COMSPEC|PATHEXT)$/i;
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => envKeys.test(name)));
  const prompt = [
    "Make the person's requested TopBot feature change in this disposable worktree only. Do not touch another folder.",
    "Keep the diff small. Only ordinary source under src/components and src/lib, and a version-only package.json bump, are eligible.",
    "Do not edit workflows, tools, policies, permissions or secrets. Never publish, push, tag, change Git config or contact GitHub.",
    "Make one local commit with the intended work. Do not install dependencies. The independent CI will run all required tests.",
    `Current version is ${job.version}. Increment only its -topbot release number.`,
    `Owner's task: ${job.task}`,
  ].join("\n");
  await new Promise((resolve, reject) => {
    const child = execFile(config.workerExecutable, [], { cwd: job.path, env, timeout: 20 * 60_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
    error => error ? reject(new Error("The isolated development worker stopped. Nothing will be published.")) : resolve());
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify({ workspace: job.path, prompt }));
  });
}

export async function githubOwner(checkout) {
  const cache = gitAt(checkout, ["-c", "credential.interactive=false", "credential", "fill"], {
    input: `protocol=https\nhost=github.com\npath=${repository}.git\nusername=topway-ai\n\n`, hidden: true,
  });
  const token = /^password=(\S+)\r?$/m.exec(cache)?.[1];
  requireState(token, "GitHub owner credential is unavailable.");
  const headers = { authorization: `Bearer ${token}`, "user-agent": "TopBot-Iteration",
    accept: "application/vnd.github+json", "x-github-api-version": "2026-03-10" };
  const call = async (path, method = "GET", body) => {
    requireState(path === "/user" || path === "/graphql" || path.startsWith(repo + "/"), "Unexpected GitHub endpoint.");
    const upload = body instanceof Blob;
    requireState(!upload || (method === "POST" && path.startsWith(repo + "/releases/") &&
      /^\/releases\/\d+\/assets\?name=(?:TopBot-[0-9.]+-topbot\.\d+-x64\.zip|topbot-windows-update\.json)$/.test(path.slice(repo.length))),
    "Unexpected GitHub upload route.");
    const r = await fetch(`https://${upload ? "uploads" : "api"}.github.com${path}`, {
      method, redirect: "error", signal: AbortSignal.timeout(upload ? 20 * 60_000 : 15_000),
      headers: { ...headers, "content-type": upload ? body.type : "application/json" },
      ...(body === undefined ? {} : { body: upload ? body : JSON.stringify(body) }) });
    if (!r.ok) { await r.body?.cancel(); throw new IterationGitHubError(r.status); }
    return r.status === 204 ? undefined : r.json();
  };
  call.download = async path => {
    requireState(path.startsWith(repo + "/actions/artifacts/") && /\/artifacts\/\d+\/zip$/.test(path), "Unexpected artifact route.");
    const redirect = await fetch(`https://api.github.com${path}`, { headers, redirect: "manual", signal: AbortSignal.timeout(15_000) });
    await redirect.body?.cancel();
    requireState(redirect.status === 302 && redirect.headers.get("location"), "GitHub did not return a signed artifact location.");
    return fetch(qualificationDownloadUrl(redirect.headers.get("location")), { redirect: "error", signal: AbortSignal.timeout(15 * 60_000) });
  };
  requireState((await call("/user"))?.login === "topway-ai", "GitHub owner identity mismatch.");
  return call;
}

async function main() {
  try { setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
  const home = join(homedir(), ".topbot-development");
  const config = JSON.parse(await readFile(join(home, "config.json"), "utf8"));
  requireState(config.automatic?.enabled === true && isAbsolute(config.checkout) &&
    (config.automatic.workerExecutable === undefined || isAbsolute(config.automatic.workerExecutable)),
  "Automatic iteration is not provisioned for this Windows profile.");
  let input = "";
  for await (const chunk of process.stdin.setEncoding("utf8")) {
    input += chunk;
    requireState(input.length <= 22_000, "Task input exceeds the limit.");
  }
  const { task, editorKey } = JSON.parse(input);
  const localEditor = config.automatic.editor === "local-qwen";
  requireState(config.automatic.workerExecutable || localEditor || (typeof editorKey === "string" && editorKey.length > 0 && editorKey.length <= 1024),
    "The isolated editor requires an OpenRouter key.");
  const lock = join(home, "iteration.lock");
  await mkdir(lock);
  try {
    const request = await githubOwner(config.checkout);
    const result = await iterateTopBot(task, { develop: args => runDevelopment(args, { home }),
      edit: job => config.automatic.workerExecutable ? editInSandbox(config.automatic, job)
        : localEditor ? editWithLocalQwen({ ...job, workspace: job.path })
          : editWithDeepSeek({ ...job, workspace: job.path }, { key: editorKey, model: config.automatic.model ?? "deepseek/deepseek-v4-flash" }),
      request, report: (stage, info = {}) => {
        void appendFile(join(home, "fixture-iteration.jsonl"), JSON.stringify({ stage, ...info }) + "\n").catch(() => {});
      }, preparePublication: (qualification, promote) => downloadQualification({ ...qualification, root: join(config.worktrees, ".qualification") },
        { read: request, download: request.download,
          use: async directory => {
            await releaseAssets(directory, qualification.version);
            await promote(options => publishQualifiedWindowsArchive(directory, qualification.version, { ...options, api: request }));
          } }) });
    console.log(JSON.stringify({ ok: true, ...result }));
  } finally { await rmdir(lock); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(); }
  catch (error) {
    await appendFile(join(homedir(), ".topbot-development", "fixture-iteration.jsonl"), JSON.stringify({ stage: "failure", error: error.message }) + "\n").catch(() => {});
    console.log(JSON.stringify({ ok: false, message: error instanceof IterationGitHubError || error instanceof TopBotReleaseGateError
      ? error.message : "Automatic iteration stopped before further writes. Check its worktree and GitHub Actions." }));
    process.exitCode = 1;
  }
}
