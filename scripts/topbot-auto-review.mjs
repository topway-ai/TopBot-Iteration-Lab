import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const sha = /^[a-f0-9]{40}$/;
const notePath = /^topbot-release-notes\/[a-z0-9][a-z0-9-]{0,39}\.txt$/;
const version = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-topbot\.(?:0|[1-9]\d*))?$/;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const secret = /(?:gh[pousr]_[a-zA-Z0-9]{30,}|github_pat_[a-zA-Z0-9_]{35,}|sk-(?:proj-)?[a-zA-Z0-9_-]{40,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/;
const privateReference = /(?:[A-Z]:\\(?:Users|ProgramData)\\|\/home\/[^/\s]+\/\.openmausbot\/)/i;
const repositoryEnv = new Set(["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_SHALLOW_FILE", "GIT_GRAFT_FILE", "GIT_NAMESPACE", "GIT_QUARANTINE_PATH"]);

export function gitAt(cwd, args, { input, hidden = false, binary = false, alternates, offline = false, isolated = false, workTree } = {}) {
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !repositoryEnv.has(key.toUpperCase())));
    const output = execFileSync("git", args, { cwd, input, timeout: 120_000, windowsHide: true,
      maxBuffer: 2 * 1024 * 1024, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      env: { ...env, ...(alternates ? { GIT_ALTERNATE_OBJECT_DIRECTORIES: JSON.stringify(alternates) } : {}),
        ...(isolated ? { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_ATTR_NOSYSTEM: "1" } : {}),
        ...(workTree ? { GIT_WORK_TREE: workTree } : {}),
        ...(offline ? { GIT_NO_LAZY_FETCH: "1" } : {}), GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" } });
    return binary ? output : utf8.decode(output);
  } catch (error) {
    if (hidden) throw new Error("GitHub credentials are unavailable. Authorize the repository's account outside the bot chat.");
    throw new Error(`git ${args[0]} failed: ${String(error.stderr ?? "").trim().slice(-900) || error.code || error.message}`);
  }
}

const sourcePath = /^(?:src\/components\/[A-Za-z][A-Za-z0-9_-]{0,63}\.(?:tsx?|css)|src\/lib\/[A-Za-z][A-Za-z0-9_-]{0,63}\.ts)$/;
const protectedName = /test|spec|fixture|mock|golden|snapshot|ratchet|policy|config|workflow|actions?|agent|instruction|prompt|skill|auth|login|logout|sign[-_]?in|sign[-_]?up|account|admin|identity|access|grant|approv|permission|session|security|privilege|vault|secret|token|key|passw|credential|cert|cookie|encrypt|decrypt|telemetry|update|publish|release|install|bootstrap|setup|deploy|build|depend|package|plugin|lockfile|pnpm|npm|yarn|harness|sandbox/i;
const sensitiveText = /(?:[a-z]:[\\/]+(?:Users|ProgramData|Documents and Settings)[\\/]|(?:\/(?:Users|home|root|private\/var\/folders)\/)|(?:^|[\s"'(])~[\\/]|file:\/\/|(?:^|[\\/])\.(?:ssh|aws|gnupg|openmausbot|topbot-development)[\\/]|-----BEGIN [^-\r\n]*PRIVATE KEY-----|(?:AKIA|ASIA)[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{12,}|(?:api[_-]?key|password|passwd|secret|token)\s*["']?\s*[:=]\s*["'][^"'\r\n]{6,}|Bearer\s+[A-Za-z0-9_.-]{12,})/i;
const privilegedSource = /\b(?:child_process|process|Deno|Bun|require|eval|Function|globalThis|window|document|navigator|localStorage|sessionStorage|indexedDB|WebSocket|XMLHttpRequest|fetch|sendBeacon|dangerouslySetInnerHTML|innerHTML|electron|ipcRenderer|importScripts)\b/;
const buildDirective = /\bnode:|@(?:import|plugin|config|source|jsx\w*)\b|url\s*\(|@vite-ignore|@ts-(?:ignore|nocheck)|<reference\b|https?:\/\//i;
const uiImport = /^[ \t]*import\s+(?:(?:type\s+)?(?:[A-Za-z_$][\w$]*(?:\s*,\s*)?)?(?:\{[\w$,\s]+\})?\s*from\s*)?(["'])([^"'\r\n]+)\1[ \t]*;?[ \t]*$/gm;
export function autoPath(file) {
  if (file === "package.json") return true;
  const name = file.slice(file.lastIndexOf("/") + 1).split(".")[0];
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) return false;
  if (notePath.test(file)) return !/auth|credential|secret|password|token|install|publish|agent|instruction|workflow|policy/i.test(name);
  return sourcePath.test(file) && !protectedName.test(name);
}

function checkText(text, sourceFile) {
  if (/[^\P{Cc}\t\n\r]|\p{Bidi_Control}/u.test(text) || /^(?:MZ|#!)/.test(text) ||
      secret.test(text) || privateReference.test(text) || sensitiveText.test(text)) throw new Error("Binary, sensitive or private content");
  if (!sourceFile) return;
  const remainder = text.replace(uiImport, (statement, _quote, specifier) => {
    if (specifier === "react" || specifier === "lucide-react") return "";
    if (!/^(?:\.\/|\.\.\/(?:components|lib)\/)[A-Za-z][\w-]*\.(?:tsx?|css)$/.test(specifier)) return statement;
    const target = path.posix.join(path.posix.dirname(sourceFile), specifier);
    return sourcePath.test(target) && autoPath(target) ? "" : statement;
  });
  if (privilegedSource.test(text) || buildDirective.test(text) || /\bimport\b|\bfrom\s*["']/.test(remainder)) {
    throw new Error("Outside ordinary UI source scope");
  }
}

function blobId(bytes) {
  return createHash("sha1").update("blob " + bytes.length + "\0").update(bytes).digest("hex");
}

function versionOnly(before, after) {
  let previous, next;
  try { previous = JSON.parse(before).version; next = JSON.parse(after).version; } catch { return false; }
  return typeof previous === "string" && typeof next === "string" && next.length <= 64 &&
    version.test(next) && next !== previous &&
    before.replace(/("version"\s*:\s*)"[^"\\]*"/, (_, key) => key + JSON.stringify(next)) === after;
}

function readTextBlob(run, oid, limit = 1024 ** 2) {
  if (Number(run(["cat-file", "-s", oid])) > limit) throw new Error("Large blob");
  const bytes = run(["cat-file", "blob", oid], { binary: true });
  return { bytes, text: utf8.decode(bytes) };
}

export function rawChanges(run, base, tree) {
  return run(["diff-tree", "-r", "--raw", "--no-commit-id", "--no-renames", "--no-abbrev",
    "--ignore-submodules=none", "-z", base, tree, "--"]);
}

export function inspectTree(run, changes, automatic = false) {
  const fields = changes.split("\0");
  if (fields.pop() !== "" || fields.length % 2) throw new Error("Invalid Git tree diff.");
  if (automatic && fields.length > 2 * 12) throw new Error("Automatic candidate exceeds the 12-file budget.");
  const files = [], blocked = [], edits = [];
  let total = 0, lines = 0;
  for (let i = 0; i < fields.length; i += 2) {
    const file = fields[i + 1];
    files.push(file);
    try {
      if (automatic && !autoPath(file)) throw new Error("Outside automatic candidate scope");
      if (!automatic && !notePath.test(file) && file !== "package.json") throw new Error("Outside the static release-note and version allowlist");
      const record = /^:(000000|100644) (000000|100644) ([0-9a-f]{40}) ([0-9a-f]{40}) ([AMD])$/.exec(fields[i]);
      if (!record) throw new Error("Not an ordinary non-executable file change");
      const [, , mode, old, oid, status] = record;
      if (automatic && status === "D") throw new Error("Automatic candidates cannot delete files");
      const limit = automatic ? 64 * 1024 : 1024 ** 2;
      const blob = status === "D" ? null : readTextBlob(run, oid, limit);
      const previous = status === "M" && (automatic || file === "package.json") && readTextBlob(run, old, limit);
      if (automatic) {
        for (const [content, id] of [[blob, oid], [previous, old]]) {
          if (!content) continue;
          if (blobId(content.bytes) !== id) throw new Error("Blob identity mismatch");
          total += content.bytes.length;
          lines += content.text.split("\n").length;
          if (total > 256 * 1024 || lines > 1600) throw new Error("Automatic candidate exceeds the text budget");
          if (file !== "package.json") checkText(content.text, notePath.test(file) ? null : file);
        }
      }
      if (!automatic) {
        total += blob?.bytes.length ?? 0;
        if (total > 2 * 1024 ** 2) throw new Error("Draft exceeds the text limit");
      }
      if (file === "package.json") {
        if (!previous || run(["hash-object", "--stdin"], { input: previous.bytes }).trim() !== old ||
            !versionOnly(previous.text, blob.text)) throw new Error("Only the existing package version may change");
      } else if (!automatic && blob && (/[^\P{Cc}\t\n\r]/u.test(blob.text) || secret.test(blob.text) || privateReference.test(blob.text))) {
        throw new Error("Binary text, possible credential or private machine path in note");
      }
      edits.push({ file, oid, mode, bytes: blob?.bytes });
    } catch (error) { blocked.push({ file, reason: error.message }); }
  }
  return { files, blocked, edits };
}

export function rebuildTree(run, base, edits) {
  run(["read-tree", base]);
  run(["update-index", "-z", "--index-info"], { input: edits.map(e => e.mode + " " + e.oid + "\t" + e.file + "\0").join("") });
  return run(["write-tree", "--missing-ok"]).trim();
}

export function candidateVersion(run, tree) {
  const manifest = readTextBlob(run, tree + ":package.json", 64 * 1024);
  const value = JSON.parse(manifest.text).version;
  if (typeof value !== "string" || value.length > 64 || !version.test(value)) throw new Error("Unsupported candidate version.");
  return value;
}

function versionIncreased(current, earlier) {
  const parts = value => value.split(/[.-]/).filter(part => part !== "topbot").map(Number);
  const left = parts(current), right = parts(earlier);
  const different = left.findIndex((part, i) => part !== (right[i] ?? -1));
  return /-topbot\.\d+$/.test(current) && left.every(Number.isSafeInteger) && right.every(Number.isSafeInteger) &&
    different >= 0 && left[different] > (right[different] ?? -1);
}

// Load this module from the trusted base. Candidate files are data, never imported or checked out.
export function reviewAutomaticSnapshot(cwd, base, head) {
  if (![base, head].every(id => typeof id === "string" && sha.test(id))) throw new Error("Expected two pinned commit SHAs.");
  const run = (args, io) => gitAt(cwd, args, { ...io, offline: true });
  if (run(["cat-file", "-t", base]).trim() !== "commit" || run(["cat-file", "-t", head]).trim() !== "commit") throw new Error("Expected commit objects.");
  if (Number(run(["cat-file", "-s", head])) > 16 * 1024) throw new Error("Oversized commit metadata.");
  const commit = run(["cat-file", "commit", head]);
  const headers = commit.split("\n\n", 1)[0].split("\n");
  const tree = headers[0].slice(5), parents = headers.filter(h => h.startsWith("parent "));
  if (headers[0] !== "tree " + tree || !sha.test(tree) || parents.length !== 1 || parents[0] !== "parent " + base) {
    throw new Error("Candidate must be a single direct child of the pinned base.");
  }
  checkText(commit, false);
  const { edits, blocked, files } = inspectTree(run, rawChanges(run, base, tree), true);
  if (blocked.length) throw new Error("Candidate blocked: " + blocked[0].reason);
  if (!files.length) throw new Error("Empty candidate.");
  const next = candidateVersion(run, tree);
  if (!versionIncreased(next, candidateVersion(run, base))) throw new Error("The candidate must increase the TopBot version.");

  // A recursive diff alone can omit empty subtrees. Reconstruct in a disposable bare index
  // with read-only access to source objects; require the complete tree to match byte-for-byte.
  const objects = run(["rev-parse", "--path-format=absolute", "--git-path", "objects"]).trimEnd();
  const stage = mkdtempSync(path.join(os.tmpdir(), "topbot-review-"));
  try {
    gitAt(stage, ["init", "--bare", "--template="], { isolated: true });
    const scratch = (args, io) => gitAt(stage, args, { ...io, alternates: objects, offline: true, isolated: true });
    if (rebuildTree(scratch, base, edits) !== tree) throw new Error("Unreviewed tree entries in candidate.");
  } finally { rmSync(stage, { recursive: true, force: true }); }
  return { tree, files: files.sort(), version: next };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 5) throw new Error("Use <repository-directory> <base-sha> <head-sha>.");
    console.log(JSON.stringify(reviewAutomaticSnapshot(...process.argv.slice(2))));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
