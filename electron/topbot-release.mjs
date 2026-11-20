import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, statfs } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import os from "node:os";
import { isNewerVersion } from "./update-version.mjs";

export const REPOSITORY = "topway-ai/TopBot-Iteration-Lab";
export const UPDATE_LIMITS = Object.freeze({ freeRAM: 3 * 1024 ** 3, reserveDisk: 3 * 1024 ** 3,
  download: 3 * 1024 ** 3, unpacked: 8 * 1024 ** 3, files: 50000, snapshot: 12 * 1024 ** 3 });
export const MANIFEST_NAME = "topbot-windows-update.json";
const versionPattern = /^\d+\.\d+\.\d+(?:-topbot\.\d+)?$/;
const downloadHosts = new Set(["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"]);

export function checkManifest(value, { current, dataEpoch = 1 } = {}) {
  if (value?.schema !== 1 || value.repository !== REPOSITORY || value.platform !== "win32-x64" ||
      !versionPattern.test(value.version) || value.dataEpoch !== dataEpoch ||
      !/^[a-f0-9]{64}$/.test(value.sha256 ?? "") ||
      !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > UPDATE_LIMITS.download ||
      !Number.isSafeInteger(value.unpackedBytes) || value.unpackedBytes < value.bytes || value.unpackedBytes > UPDATE_LIMITS.unpacked) {
    throw new Error("Invalid or incompatible TopBot update manifest; no files were installed.");
  }
  const url = new URL(value.url);
  const expected = `https://github.com/${REPOSITORY}/releases/download/v${value.version}/TopBot-${value.version}-x64.zip`;
  if (url.href !== expected) throw new Error("Update asset must belong to the pinned TopBot repository and version.");
  if (current && !isNewerVersion(value.version, current)) return null;
  return { schema: 1, repository: REPOSITORY, platform: value.platform, version: value.version,
    dataEpoch, sha256: value.sha256, bytes: value.bytes, unpackedBytes: value.unpackedBytes, url: url.href };
}

export async function trustedFetch(url, { fetchImpl = fetch, signal = AbortSignal.timeout(30000), api = false } = {}) {
  let target = new URL(url);
  for (let hop = 0; hop < 5; hop++) {
    if (target.protocol !== "https:" || target.username || target.password || target.port ||
        !(downloadHosts.has(target.hostname) || (api && target.hostname === "api.github.com"))) {
      throw new Error("Untrusted update download address.");
    }
    const response = await fetchImpl(target.href, { redirect: "manual", signal,
      headers: { "User-Agent": "TopBot-Updater", Accept: "application/vnd.github+json" } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) throw new Error("Update redirect has no destination.");
      target = new URL(location, target);
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Update server answered HTTP ${response.status}.`); }
    return response;
  }
  throw new Error("Too many update redirects.");
}

async function boundedJson(response, limit) {
  const chunks = [];
  let size = 0;
  for await (const part of response.body) {
    size += part.length;
    if (size > limit) throw new Error("Update metadata is too large.");
    chunks.push(Buffer.from(part));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function findRelease(options = {}) {
  const response = await trustedFetch(`https://api.github.com/repos/${REPOSITORY}/releases?per_page=20`, { ...options, api: true });
  const releases = await boundedJson(response, 1024 * 1024);
  if (!Array.isArray(releases)) throw new Error("Invalid release listing.");
  const candidates = releases.filter(r => r?.immutable === true && r.draft === false && r.prerelease === false && typeof r.tag_name === "string" &&
    versionPattern.test(r.tag_name.replace(/^v/, "")) && isNewerVersion(r.tag_name.replace(/^v/, ""), options.current));
  candidates.sort((a, b) => isNewerVersion(a.tag_name, b.tag_name) ? -1 : 1);
  for (const release of candidates) {
    const asset = release.assets?.find(a => a.name === MANIFEST_NAME);
    if (!asset) continue;
    const expected = `https://github.com/${REPOSITORY}/releases/download/${release.tag_name}/${MANIFEST_NAME}`;
    if (asset.browser_download_url !== expected) throw new Error("Unexpected update manifest address.");
    const manifest = checkManifest(await boundedJson(await trustedFetch(expected, options), 16384), options);
    if (!manifest || `v${manifest.version}` !== release.tag_name) throw new Error("Release version does not match its manifest.");
    return manifest;
  }
  return null;
}

export async function resourcePreflight(directory, needed = 0, { freeRAM = os.freemem, disk = statfs } = {}) {
  if (freeRAM() < UPDATE_LIMITS.freeRAM) throw new Error("Update paused: less than 3 GB RAM is available.");
  const stats = await disk(directory);
  if (stats.bavail * stats.bsize < needed + UPDATE_LIMITS.reserveDisk) throw new Error("Update paused: insufficient disk space including the 3 GB reserve.");
}

export async function downloadRelease(manifest, destination, { fetchImpl, onProgress = () => {} } = {}) {
  await mkdir(dirname(destination), { recursive: true });
  await resourcePreflight(dirname(destination), manifest.bytes + manifest.unpackedBytes);
  const part = `${destination}.partial`;
  let received = 0, lastProgress = 0;
  const hash = createHash("sha256");
  try {
    const response = await trustedFetch(manifest.url, { fetchImpl, signal: AbortSignal.timeout(15 * 60 * 1000) });
    const length = response.headers.get("content-length");
    if (length && Number(length) !== manifest.bytes) { await response.body?.cancel(); throw new Error("Update download size mismatch."); }
    await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _encoding, done) {
      received += chunk.length;
      if (received > manifest.bytes) return done(new Error("Update exceeds its declared size."));
      hash.update(chunk);
      if (Date.now() - lastProgress > 500) { lastProgress = Date.now(); onProgress(Math.floor(received / manifest.bytes * 100)); }
      done(null, chunk);
    } }), createWriteStream(part, { flags: "wx" }));
    if (received !== manifest.bytes || hash.digest("hex") !== manifest.sha256) throw new Error("Update SHA-256 or size verification failed.");
    await rename(part, destination);
  } catch (error) {
    await rm(part, { force: true });
    throw error;
  }
}

export async function readUpdateJson(file, fallback = null) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}
