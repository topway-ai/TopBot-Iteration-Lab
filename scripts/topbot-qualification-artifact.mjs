import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { MANIFEST_NAME, REPOSITORY, resourcePreflight, UPDATE_LIMITS } from "../electron/topbot-release.mjs";

const repo = `/repos/${REPOSITORY}`, repoId = 1464902386;
const id = value => Number.isSafeInteger(value) && value > 0;
const expectedVersion = /^\d+\.\d+\.\d+-topbot\.\d+$/;
const expectedSha = /^[a-f0-9]{40}$/;
const runFile = promisify(execFile);

function requireState(condition, message) {
  if (!condition) throw new Error(message);
}

export function qualificationArtifact(list, { run, head, branch }) {
  requireState(id(run) && expectedSha.test(head) && /^topbot-(auto|dev)\/[a-z0-9-]{1,40}$/.test(branch), "Invalid Windows qualification identity.");
  requireState(list?.total_count === 1 && Array.isArray(list.artifacts) && list.artifacts.length === 1, "No unique qualification artifact.");
  const [artifact] = list.artifacts, receipt = artifact?.workflow_run;
  requireState(id(artifact?.id) && artifact.name === "topbot-windows-update-1" && artifact.expired === false &&
    id(artifact.size_in_bytes) && artifact.size_in_bytes <= UPDATE_LIMITS.download + 8 * 1024 ** 2 &&
    /^sha256:[a-f0-9]{64}$/.test(artifact.digest) && receipt?.id === run && receipt.head_sha === head &&
    receipt.head_branch === branch && receipt.repository_id === repoId && receipt.head_repository_id === repoId,
  "The qualification artifact does not match the exact workflow run, commit, branch and repository.");
  return artifact;
}

export function qualificationDownloadUrl(value) {
  const url = new URL(value);
  requireState(url.protocol === "https:" && !url.port && !url.username && !url.password &&
    (url.hostname.endsWith(".blob.core.windows.net") || url.hostname.endsWith(".actions.githubusercontent.com") ||
      url.hostname === "objects.githubusercontent.com" || url.hostname === "release-assets.githubusercontent.com"),
  "Untrusted artifact download location.");
  return url.href;
}

export async function downloadQualification({ run, head, branch, version, root }, { read, download, use,
  tar = join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe"), preflight = resourcePreflight }) {
  requireState(expectedVersion.test(version), "Invalid candidate version.");
  const artifact = qualificationArtifact(await read(`${repo}/actions/runs/${run}/artifacts?per_page=100`), { run, head, branch });
  await mkdir(root, { recursive: true });
  await preflight(root, 2 * artifact.size_in_bytes);
  const temporary = await mkdtemp(join(root, "qualified-"));
  try {
    const archive = join(temporary, "workflow.zip");
    const response = await download(`${repo}/actions/artifacts/${artifact.id}/zip`);
    requireState(response.ok && response.body, "Could not download the qualified Windows artifact.");
    const hash = createHash("sha256");
    let size = 0;
    await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _encoding, done) {
      size += chunk.length;
      if (size > artifact.size_in_bytes) { done(new Error("The artifact exceeded its verified size.")); return; }
      hash.update(chunk);
      done(null, chunk);
    } }), createWriteStream(archive, { flags: "wx" }));
    requireState(size === artifact.size_in_bytes && `sha256:${hash.digest("hex")}` === artifact.digest, "The artifact digest or size did not match GitHub.");
    const names = [`TopBot-${version}-x64.zip`, MANIFEST_NAME].sort();
    const exec = args => runFile(tar, args, { windowsHide: true, maxBuffer: 64_000, timeout: 120_000 });
    const entries = (await exec(["-tf", archive])).stdout.trim().split(/\r?\n/).sort();
    requireState(entries.length === names.length && entries.every((name, i) => name === names[i]), "Unexpected files in the qualification artifact.");
    const types = (await exec(["-tvf", archive])).stdout.trim().split(/\r?\n/);
    requireState(types.length === names.length && types.every(line => line.startsWith("-")), "Qualification artifact contains a non-regular file.");
    const files = join(temporary, "release");
    await mkdir(files);
    await exec(["-xf", archive, "-C", files, ...names]);
    for (const name of names) requireState((await lstat(join(files, name))).isFile(), "Qualification artifact extraction is invalid.");
    return await use(files);
  } finally {
    await rm(temporary, { recursive: true, force: true, maxRetries: 2 });
  }
}
