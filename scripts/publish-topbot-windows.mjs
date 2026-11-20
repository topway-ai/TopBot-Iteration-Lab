import { createHash } from "node:crypto";
import { openAsBlob } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { checkManifest, MANIFEST_NAME, REPOSITORY } from "../electron/topbot-release.mjs";
import { normalizeTagRulesetProof, resolveTagRulesetProof, tagRulesetProof } from "./topbot-tag-ruleset.mjs";
import { verifyWindowsReleaseGate } from "./topbot-release-gate.mjs";
import { isNewerVersion } from "../electron/update-version.mjs";

const repo = `/repos/${REPOSITORY}`;
function requireState(condition, reason) {
  if (!condition) throw new Error(reason);
}

export async function releaseAssets(directory, version) {
  const manifestBytes = await readFile(join(directory, MANIFEST_NAME));
  const manifest = checkManifest(JSON.parse(manifestBytes));
  requireState(manifest.version === version, "Artifact version differs from the reviewed package.json.");
  const name = `TopBot-${version}-x64.zip`;
  const entries = await readdir(directory, { withFileTypes: true });
  requireState(entries.length === 2 && entries.every(e => e.isFile() && [name, MANIFEST_NAME].includes(e.name)),
    "Expected only the qualified archive and manifest.");
  const archive = await openAsBlob(join(directory, name), { type: "application/zip" });
  const hash = createHash("sha256");
  for await (const part of archive.stream()) hash.update(part);
  requireState(archive.size === manifest.bytes && hash.digest("hex") === manifest.sha256, "Archive differs from manifest.");
  return [
    { name, body: archive, digest: `sha256:${manifest.sha256}` },
    { name: MANIFEST_NAME, body: new Blob([manifestBytes], { type: "application/json" }),
      digest: `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}` },
  ];
}

export async function publishWindowsUpdate(directory, version, env, request) {
  const sha = env.GITHUB_SHA;
  const owner = REPOSITORY.split("/")[0];
  requireState(env.GITHUB_REPOSITORY === REPOSITORY && env.GITHUB_REF === "refs/heads/main" &&
    env.GITHUB_EVENT_NAME === "workflow_dispatch" && [env.GITHUB_ACTOR, env.GITHUB_TRIGGERING_ACTOR]
      .every(actor => actor?.toLowerCase() === owner) && /^[a-f0-9]{40}$/.test(sha) &&
    env.REVIEWED_SHA === sha && env.GH_TOKEN, "Publish requires the owner and the exact reviewed main SHA.");
  requireState(typeof env.TOPBOT_RELEASE_POLICY_TOKEN === "string" && env.TOPBOT_RELEASE_POLICY_TOKEN.trim() &&
    env.TOPBOT_RELEASE_POLICY_TOKEN !== env.GH_TOKEN, "Publish requires a separate read-only TOPBOT_RELEASE_POLICY_TOKEN.");
  async function api(path, method = "GET", data, token = env.GH_TOKEN) {
    const upload = data instanceof Blob;
    const response = await request(`https://${upload ? "uploads" : "api"}.github.com${path}`, {
      method, redirect: "error", signal: AbortSignal.timeout(upload ? 20 * 60_000 : 30_000),
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28", "content-type": upload ? data.type : "application/json" },
      body: upload ? data : JSON.stringify(data),
    });
    requireState(response.status === (method === "POST" ? 201 : 200), `${method} ${path}: HTTP ${response.status}. Stop and inspect before retrying.`);
    return response.json();
  }
  return publishQualifiedWindowsArchive(directory, version, {
    sha, api, ruleRead: path => api(path, "GET", undefined, env.TOPBOT_RELEASE_POLICY_TOKEN),
    requestedProof: env.REVIEWED_TAG_RULESET,
    verifiedRun: env.VERIFIED_CI_RUN ? Number(env.VERIFIED_CI_RUN) : undefined,
    attestations: (env.TOPBOT_AUTOMATIC_MAIN_RULESETS ?? "").split(",").map(part => normalizeTagRulesetProof(part.trim())).filter(Boolean),
  });
}

/** A trusted publisher must verify the same exact commit, repository policy and bytes before every external write. */
export async function publishQualifiedWindowsArchive(directory, version, { sha, api, ruleRead = api, requestedProof, verifiedRun, attestations = [] }) {
  requireState(/^[a-f0-9]{40}$/.test(sha) && /^\d+\.\d+\.\d+-topbot\.\d+$/.test(version), "Invalid release commit or version.");
  const tag = `v${version}`, ref = `refs/tags/${tag}`;
  const assets = await releaseAssets(directory, version);
  const ownerProof = normalizeTagRulesetProof(requestedProof);
  requireState(!requestedProof || ownerProof, "Invalid owner tag ruleset proof.");
  const proof = ownerProof || await resolveTagRulesetProof(api, tag);
  const id = proof?.split("@")[0];
  requireState(/^[1-9]\d*$/.test(id), "No verified no-bypass tag ruleset for this release.");
  async function verifyProtection() {
    const rule = await api(`${repo}/rulesets/${id}`);
    requireState(tagRulesetProof(rule, tag, ownerProof ?? "") === proof,
      "Tag ruleset changed, is ineligible, or bypass actors cannot be verified.");
  }
  function verifyTag(result) {
    requireState(result?.ref === ref && result.object?.type === "commit" && result.object.sha === sha,
      "Tag is not bound directly to the reviewed build commit.");
  }
  async function findOnlyRelease(expectedId) {
    // The by-tag endpoint only promises published releases. The write token's list includes drafts.
    let found;
    for (let page = 1; page <= 20; page++) {
      const releases = await api(`${repo}/releases?per_page=100&page=${page}`);
      requireState(Array.isArray(releases) && releases.length <= 100, "Invalid release listing.");
      for (const release of releases) {
        requireState(typeof release?.tag_name === "string", "Invalid release listing.");
        if (release.tag_name !== tag) continue;
        requireState(expectedId && release.id === expectedId && release.draft === true && !found,
          "Version already has a release or a competing draft. Inspect it; do not reuse this version.");
        found = release;
      }
      if (releases.length < 100) {
        requireState(!expectedId || found, "New draft disappeared or changed tag.");
        return found;
      }
    }
    throw new Error("Cannot verify the complete release listing.");
  }
  function verifyAssets(remote) {
    requireState(Array.isArray(remote) && remote.length === assets.length && assets.every(asset =>
      remote.some(r => r.name === asset.name && r.state === "uploaded" && r.size === asset.body.size && r.digest === asset.digest)),
      "Release assets differ from the qualified build.");
  }

  const policy = () => verifyWindowsReleaseGate(ruleRead, sha, undefined, verifiedRun, attestations);
  const qualified = await policy();
  const previous = await api(`${repo}/contents/package.json?ref=${qualified.base}`);
  requireState(previous?.type === "file" && previous.encoding === "base64" && typeof previous.content === "string" &&
    previous.content.length < 350_000, "Cannot verify the previous package version.");
  const baseline = JSON.parse(Buffer.from(previous.content, "base64").toString("utf8")).version;
  requireState(typeof baseline === "string" && isNewerVersion(version, baseline), "The release version did not increase relative to its parent.");
  await verifyProtection();
  await findOnlyRelease();
  // Create-only reservation. Even a same-SHA conflict or a lost success response is not ours to adopt.
  verifyTag(await api(`${repo}/git/refs`, "POST", { ref, sha }));
  const readTag = async () => verifyTag(await api(`${repo}/git/ref/tags/${tag}`));
  await readTag();
  const binding = { tag_name: tag, target_commitish: sha };
  const draft = await api(`${repo}/releases`, "POST", { ...binding, draft: true, name: `TopBot ${version}`,
    body: "Windows update with program backup, health checks and rollback. Data format epoch 1." });
  requireState(Number.isSafeInteger(draft?.id) && draft.id > 0 && draft.draft === true && draft.tag_name === tag &&
    draft.assets?.length === 0, "Unexpected response creating draft.");
  const path = `${repo}/releases/${draft.id}`;
  for (const asset of assets) await api(`${path}/assets?name=${asset.name}`, "POST", asset.body);
  verifyAssets((await findOnlyRelease(draft.id)).assets);
  await verifyProtection();
  const finalGate = await policy();
  for (const key of ["sha", "head", "base", "pullRequest", "ciRun", "ciAttempt", "approval"]) {
    requireState(finalGate[key] === qualified[key], "Approved source, review or CI changed during release staging.");
  }
  // Tag guards close the tag race. Draft mutation is still restricted to trusted writers.
  await readTag();
  const finalDraft = await api(path);
  requireState(finalDraft?.id === draft.id && finalDraft.tag_name === tag && finalDraft.draft === true,
    "Draft ID, tag or visibility changed before publication.");
  verifyAssets(finalDraft.assets);
  const published = await api(path, "PATCH", { ...binding, draft: false, prerelease: false, make_latest: "false" });
  requireState(published.id === draft.id && published.tag_name === tag && published.draft === false &&
    published.prerelease === false && published.immutable === true, "Unexpected or mutable publication state; inspect manually.");
  verifyAssets(published.assets);
  await readTag();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url)));
  await publishWindowsUpdate(process.argv[2], version, process.env, fetch);
}
