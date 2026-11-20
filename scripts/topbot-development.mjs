import { candidateVersion, gitAt, inspectTree, rawChanges, rebuildTree } from "./topbot-auto-review.mjs";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, rmdirSync, statfsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
export { gitAt };

const repo = "topway-ai/TopBot-Iteration-Lab";
const origin = `https://github.com/${repo}.git`;
const baseRef = "refs/remotes/origin/main";
const GiB = 1024 ** 3;
const sha = /^[a-f0-9]{40}$/;
const slug = /^[a-z0-9][a-z0-9-]{0,39}$/;
function objectFile(file) { return JSON.parse(readFileSync(file, "utf8")); }
function atomicJson(file, value) {
  const pending = `${file}.${process.pid}.pending`;
  writeFileSync(pending, JSON.stringify(value, null, 2), { mode: 0o600, flag: "wx" });
  renameSync(pending, file);
}

function samePath(a, b) {
  const canonical = value => process.platform === "win32" ? realpathSync(value).toLowerCase() : realpathSync(value);
  return canonical(a) === canonical(b);
}

function startWorker(git, candidate, checkout, branch, base) {
  mkdirSync(candidate);
  const run = args => git(candidate, args, { isolated: true });
  run(["init", "--template="]);
  for (const [key, value] of [["core.hooksPath", "/dev/null"], ["core.fsmonitor", "false"], ["core.autocrlf", "false"],
    ["credential.helper", ""], ["credential.interactive", "false"], ["commit.gpgSign", "false"],
    ["user.name", "TopBot Worker"], ["user.email", "worker@users.noreply.github.com"]]) run(["config", "--local", key, value]);
  // File transport, not a shared/local clone: no hardlinks, alternates, borrowed refs or private history.
  run(["fetch", "--no-write-fetch-head", "--no-tags", "--no-recurse-submodules", "--depth=1", pathToFileURL(checkout).href, base]);
  run(["checkout", "-b", branch, base]);
  run(["remote", "add", "origin", origin]);
}

function withWorkerView(git, home, candidate, job, inspect) {
  const metadata = path.join(candidate, ".git"), ref = `refs/heads/${job.branch}`;
  const objects = path.join(metadata, "objects");
  const inside = file => path.relative(realpathSync(candidate), realpathSync(file)) === path.relative(candidate, file);
  if (!lstatSync(metadata).isDirectory() || !inside(metadata) || !inside(objects) ||
      existsSync(path.join(objects, "info", "alternates")) || existsSync(path.join(objects, "info", "http-alternates"))) {
    throw new Error("Expected an independent worker object store.");
  }
  const view = mkdtempSync(path.join(home, "worker-view-"));
  try {
    git(view, ["init", "--bare", "--template="], { isolated: true });
    // Copy only Git data. Never load worker config, hooks, grafts, replace refs or filter drivers.
    for (const name of ["HEAD", ref, "packed-refs", "index", "shallow"]) {
      const file = path.join(metadata, name);
      if (!existsSync(file) && !["HEAD", "index"].includes(name)) continue;
      const info = lstatSync(file);
      if (!info.isFile() || !inside(file) || info.size > 32 * 1024 ** 2) throw new Error("Unexpected worker Git metadata.");
      const target = path.join(view, name);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(file, target);
    }
    if (readFileSync(path.join(view, "HEAD"), "utf8").trimEnd() !== `ref: ${ref}`) throw new Error("Worker is on a different branch.");
    const run = (args, options) => git(view, args, { ...options, offline: true, isolated: true, workTree: candidate, alternates: objects });
    return inspect(run);
  } finally { rmSync(view, { recursive: true, force: true }); }
}

function createSnapshotBranch(git, home, job, tree, changes, edits, reserve) {
  const stage = mkdtempSync(path.join(home, "snapshot-"));
  const run = (args, options) => git(stage, args, options);
  try {
    run(["init", "--bare", "--template="]);
    run(["fetch", "--no-tags", "--no-recurse-submodules", "--depth=1", "--filter=blob:none", origin, "refs/heads/main"]);
    if (run(["rev-parse", "FETCH_HEAD^{commit}"]).trim() !== job.base) throw new Error("Draft blocked: the job base is not current GitHub main.");
    for (const { oid, bytes } of edits) {
      if (bytes && run(["hash-object", "-w", "--stdin"], { input: bytes }).trim() !== oid) throw new Error("Draft blob identity mismatch.");
    }
    // Check both sides of every edit against the independently fetched base, without hydrating base blobs.
    if (rebuildTree(run, job.base, edits) !== tree || rawChanges(run, job.base, tree) !== changes) {
      throw new Error("Draft blocked: the approved blobs do not reconstruct the reviewed changes.");
    }

    // Deterministic metadata makes retrying idempotent without copying any source commit headers.
    const time = run(["show", "-s", "--format=%ct", job.base]).trim();
    if (!/^\d+$/.test(time)) throw new Error("Invalid main commit timestamp.");
    const identity = `TopBot Development <topbot-development@users.noreply.github.com> ${time} +0000`;
    const kind = job.mode === "automatic" ? "candidate" : "draft";
    const input = `tree ${tree}\nparent ${job.base}\nauthor ${identity}\ncommitter ${identity}\n\nReviewed TopBot ${kind}\n`;
    const snapshot = run(["hash-object", "-t", "commit", "-w", "--stdin"], { input }).trim();
    if (!sha.test(snapshot)) throw new Error("Invalid snapshot commit.");
    const ref = `refs/heads/${job.branch}`;
    const advertised = run(["ls-remote", "--refs", origin, ref]).trimEnd();
    if (advertised) throw new Error("Draft branch already exists; manual recovery required. Do not reuse this head.");
    const refspec = `${snapshot}:${ref}`;
    // Consume the slug before the write: a lost response cannot authorize another push.
    reserve(snapshot);
    const output = run(["push", "--porcelain", "--no-verify", "--no-follow-tags", "--no-thin", "--recurse-submodules=no",
      `--force-with-lease=${ref}:`, origin, refspec]);
    const updates = output.split(/\r?\n/).filter(line => line.includes("\t"));
    if (updates.length !== 1 || !updates[0].startsWith(`*\t${refspec}\t`)) throw new Error("Git did not confirm creation of a new branch.");
    return snapshot;
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

const positiveId = value => Number.isSafeInteger(value) && value > 0;
function matchesPull(pr, job, snapshot) {
  return positiveId(pr?.id) && positiveId(pr.number) && pr.state === "open" && pr.draft === (job.mode !== "automatic") &&
    pr.html_url === `https://github.com/${repo}/pull/${pr.number}` &&
    pr.base?.repo?.full_name === repo && pr.base.ref === "main" && pr.base.sha === job.base &&
    pr.head?.repo?.full_name === repo && pr.head.ref === job.branch && pr.head.sha === snapshot;
}

function authenticatedGitHub(checkout, request = fetch) {
  const credential = gitAt(checkout, ["-c", "credential.interactive=false", "credential", "fill"], {
    input: `protocol=https\nhost=github.com\npath=${repo}.git\nusername=topway-ai\n\n`, hidden: true,
  }).split(/\r?\n/).find(line => line.startsWith("password="))?.slice(9);
  if (!credential) throw new Error("No cached GitHub credential for the TopBot repository.");
  return async (urlPath, payload) => {
    const response = await request(`https://api.github.com${urlPath}`, { redirect: "error", signal: AbortSignal.timeout(20_000),
      method: payload ? "POST" : "GET", headers: { authorization: `Bearer ${credential}`, "user-agent": "TopBot-Development",
        accept: "application/vnd.github+json", "content-type": "application/json" }, ...(payload ? { body: JSON.stringify(payload) } : {}) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`GitHub returned HTTP ${response.status}; no approval or release was attempted.`); }
    return response.json();
  };
}

export async function runDevelopment(args, { home = path.join(os.homedir(), ".topbot-development"), git = gitAt,
  availableRam = os.freemem, disk = statfsSync, connect = authenticatedGitHub } = {}) {
  const [command, value, ...extra] = args;
  const starting = command === "start" || command === "start-auto";
  const retiring = command === "retire-auto";
  if (!["doctor", "start", "start-auto", "review", "draft", "candidate", "finish", "retire-auto"].includes(command) || extra.length ||
      (starting || retiring ? !slug.test(value ?? "") : value !== undefined)) {
    throw new Error("Use doctor, start <slug>, start-auto <slug>, review, draft, candidate, finish, or retire-auto <slug>.");
  }
  const { checkout, worktrees } = objectFile(path.join(home, "config.json"));
  if (![checkout, worktrees].every(value => typeof value === "string" && path.isAbsolute(value))) throw new Error("Configure absolute checkout and worktree paths.");
  const root = realpathSync(worktrees), repoRoot = realpathSync(checkout);
  if (root === repoRoot || root.startsWith(repoRoot + path.sep) || repoRoot.startsWith(root + path.sep)) {
    throw new Error("The worktree root must be separate from the original checkout.");
  }
  const localGit = (...args) => git(repoRoot, args).trim();
  if (localGit("remote", "get-url", "origin") !== origin || localGit("remote", "get-url", "--push", "origin") !== origin) {
    throw new Error(`Expected the development checkout to point to ${origin}.`);
  }
  const stateFile = path.join(home, "active.json");
  const state = () => existsSync(stateFile) ? objectFile(stateFile) : null;
  const resources = () => {
    const stats = disk(root);
    return { freeRAM: availableRam(), freeDisk: stats.bavail * stats.bsize, minimumRAM: 3 * GiB, minimumDisk: 6 * GiB };
  };
  const preflight = () => {
    const r = resources();
    if (r.freeRAM < r.minimumRAM || r.freeDisk < r.minimumDisk) throw new Error("Development paused: need 3 GiB free RAM and 6 GiB free staging disk.");
  };
  const review = job => {
    const automatic = job?.mode === "automatic";
    if (!job || (job.mode !== undefined && !automatic) || !slug.test(job.slug) ||
        job.branch !== `${automatic ? "topbot-auto" : "topbot-dev"}/${job.slug}` || !sha.test(job.base) ||
        (job.published !== undefined && !sha.test(job.published))) throw new Error("No valid active development job.");
    const candidate = path.join(root, job.slug);
    if (!samePath(candidate, job.path) || lstatSync(candidate).isSymbolicLink()) throw new Error("Job directory no longer matches.");
    if (!automatic && (!samePath(candidate, git(candidate, ["rev-parse", "--show-toplevel"]).trim()) ||
        git(candidate, ["branch", "--show-current"]).trim() !== job.branch ||
        git(candidate, ["remote", "get-url", "--push", "origin"]).trim() !== origin)) throw new Error("The active worktree or its push target no longer matches the job.");
    const inspect = run => inspectJob(run, job, automatic);
    return automatic ? withWorkerView(git, home, candidate, job, inspect) : inspect((args, options) => git(candidate, args, options));
  };
  function inspectJob(run, job, automatic) {
    const head = run(["rev-parse", "HEAD^{commit}"]).trim();
    if (!sha.test(head)) throw new Error("Invalid source commit.");
    run(["merge-base", "--is-ancestor", job.base, head]);
    const tree = run(["rev-parse", `${head}^{tree}`]).trim();
    const changes = rawChanges(run, job.base, tree);
    const { files, blocked, edits } = inspectTree(run, changes, automatic);
    if (automatic && !blocked.length && files.length) candidateVersion(run, tree);
    const submodules = automatic ? "--ignore-submodules=all" : "--ignore-submodules=none";
    const dirty = Boolean(run(["--no-optional-locks", "status", "--porcelain=v1", "-z", submodules, "--untracked-files=all"]));
    if (dirty) {
      const pending = [run(["diff", "--name-only", "--no-renames", submodules, "-z", head, "--"]), run(["ls-files", "--others", "--exclude-standard", "-z"])];
      files.push(...pending.join("").split("\0").filter(Boolean));
    }
    if (command === "candidate" && !dirty && !blocked.length) run(["diff", "--no-ext-diff", "--no-textconv", "--check", job.base, head, "--"]);
    return { tree, changes, edits, report: { ...job, head, dirty, files: [...new Set(files)].sort(), blocked, ownerReview: [] } };
  }
  if (command === "doctor") return { repository: repo, checkout: repoRoot, worktrees: root, active: state(), resources: resources(),
    localBuilds: "focused tests only; Windows packaging belongs on GitHub Actions", release: "not available through this controller" };
  if (command === "review") return review(state()).report;

  const lock = path.join(home, "operation.lock");
  try { mkdirSync(lock); } catch { throw new Error("Another development operation is active. Inspect the job instead of removing its lock."); }
  try {
    const job = state();
    if (retiring) {
      if (job?.mode !== "automatic" || job.slug !== value || job.branch !== `topbot-auto/${value}`) throw new Error("No matching automatic job to retire.");
      const archived = path.join(home, `${value}.json`);
      if (existsSync(archived)) throw new Error("A job with this slug was already archived.");
      renameSync(stateFile, archived);
      return { archived, worktreeRetained: job.path };
    }
    preflight();
    if (starting) {
      if (job) throw new Error(`Finish the active ${job.branch} job before starting another.`);
      if (existsSync(path.join(home, `${value}.json`))) throw new Error("This job slug was already used; choose a new slug.");
      const candidate = path.join(root, value);
      if (existsSync(candidate)) throw new Error("The job directory already exists; choose a different slug.");
      localGit("fetch", "--no-tags", "origin", `refs/heads/main:${baseRef}`);
      const automatic = command === "start-auto";
      const base = localGit("rev-parse", baseRef), branch = `${automatic ? "topbot-auto" : "topbot-dev"}/${value}`;
      if (!sha.test(base)) throw new Error("GitHub main did not resolve to a commit.");
      if (automatic) startWorker(git, candidate, repoRoot, branch, base);
      else localGit("worktree", "add", "-b", branch, candidate, base);
      const created = { slug: value, path: candidate, branch, base, ...(automatic ? { mode: "automatic" } : {}) };
      atomicJson(stateFile, created);
      return { ...created, resources: resources() };
    }
    const automatic = job?.mode === "automatic";
    if ((command === "candidate" && !automatic) || (command === "draft" && automatic)) throw new Error("Publication command does not match the job mode.");
    const { report: checked, changes, edits, tree } = review(job);
    if (checked.dirty) throw new Error("The development worktree still has uncommitted changes.");
    if (command === "finish") {
      const archived = path.join(home, `${job.slug}.json`);
      if (existsSync(archived)) throw new Error("A job with this slug was already archived.");
      renameSync(stateFile, archived);
      return { archived, worktreeRetained: job.path };
    }
    if (job.published !== undefined || job.publishedTree !== undefined || job.pull !== undefined) {
      if (!sha.test(job.published) || !sha.test(job.publishedTree) || !positiveId(job.pull?.id) || !positiveId(job.pull?.number)) {
        throw new Error("Publication has no complete receipt; manual recovery required. No further publication is permitted.");
      }
      if (tree !== job.publishedTree) throw new Error("This slug already published an immutable snapshot. Start a new job for changed work.");
    }
    if (checked.blocked.length || !checked.files.length || checked.head === job.base || !sha.test(checked.head)) throw new Error(`${automatic ? "Candidate" : "Draft"} blocked: inspect review for unsupported paths, secrets, or an empty diff.`);
    if (!automatic) git(job.path, ["diff", "--no-ext-diff", "--no-textconv", "--check", job.base, checked.head, "--"]);
    const github = connect(repoRoot);
    const identity = await github("/user");
    if (identity.login !== "topway-ai") throw new Error("GitHub selected an account other than topway-ai; nothing was published.");
    // No base filter: even one additional PR for another target makes this head ambiguous.
    const query = new URLSearchParams({ head: `topway-ai:${job.branch}`, state: "open", per_page: "2" });
    const pullPath = `/repos/${repo}/pulls`;
    const openPulls = async () => {
      const pulls = await github(`${pullPath}?${query}`);
      if (!Array.isArray(pulls)) throw new Error("Invalid open PR listing; manual recovery required.");
      return pulls;
    };
    const checkRemote = snapshot => {
      const ref = `refs/heads/${job.branch}`;
      if (localGit("ls-remote", "--refs", origin, ref) !== `${snapshot}\t${ref}`) throw new Error("Published head is missing or changed; manual recovery required.");
    };
    const confirm = (pulls, snapshot, receipt) => {
      const [pr] = pulls;
      if (pulls.length !== 1 || !matchesPull(pr, job, snapshot) || pr.id !== receipt.id || pr.number !== receipt.number) {
        throw new Error("The original PR is missing, changed or ambiguous; manual recovery required.");
      }
      if (automatic) return { draft: pr.html_url, head: snapshot, pr: pr.number, base: job.base, branch: job.branch };
      return { draft: pr.html_url, head: snapshot, ownerReview: checked.ownerReview, release: "not requested" };
    };
    const before = await openPulls();
    if (job.published) {
      checkRemote(job.published);
      return confirm(before, job.published, job.pull);
    }
    if (before.length) throw new Error("An open PR already uses this head; manual recovery required.");
    let pending;
    try {
      const snapshot = createSnapshotBranch(git, home, job, tree, changes, edits, published => {
        pending = { ...job, published, publishedTree: tree };
        atomicJson(stateFile, pending);
      });
      checkRemote(snapshot);
      if ((await openPulls()).length) throw new Error("An open PR appeared for the new head.");
      const created = await github(pullPath, { base: "main", head: job.branch, draft: !automatic,
        title: job.slug.replaceAll("-", " "),
        body: automatic ? `Automated candidate from \`${job.base}\`. Verify the pinned commit with the trusted base audit.` :
          `Prepared from \`${job.base}\` for review. No release was requested.\n\nReview the diff and test evidence before marking the draft ready.` });
      if (!matchesPull(created, job, snapshot)) throw new Error("GitHub did not confirm the requested PR.");
      const pull = { id: created.id, number: created.number };
      checkRemote(snapshot);
      const result = confirm(await openPulls(), snapshot, pull);
      atomicJson(stateFile, { ...pending, pull });
      return result;
    } catch (error) {
      if (pending) throw new Error(`Publication not confirmed; manual recovery required. ${error.message}`);
      throw error;
    }
  } finally { rmdirSync(lock); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
  try { console.log(JSON.stringify(await runDevelopment(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
