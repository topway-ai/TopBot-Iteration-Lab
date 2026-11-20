import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { downloadQualification, qualificationArtifact, qualificationDownloadUrl } from "./topbot-qualification-artifact.mjs";

const candidate = { run: 17, head: "c".repeat(40), branch: "topbot-auto/fixture", version: "0.1.161-topbot.10" };
const receipt = { id: candidate.run, head_sha: candidate.head, head_branch: candidate.branch, repository_id: 1464902386, head_repository_id: 1464902386 };
const fixture = bytes => ({ id: 9, name: "topbot-windows-update-1", expired: false, size_in_bytes: bytes.length,
  digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, workflow_run: receipt });
const results = artifact => ({ total_count: 1, artifacts: [artifact] });

test("one artifact must belong to the exact qualified GitHub run and commit", () => {
  const ok = fixture(Buffer.from("data"));
  assert.equal(qualificationArtifact(results(ok), candidate), ok);
  for (const artifact of [{ ...ok, expired: true }, { ...ok, name: "topbot-windows-update-2" },
    { ...ok, digest: "" }, { ...ok, size_in_bytes: 1e12 },
    ...Object.keys(receipt).map(field => ({ ...ok, workflow_run: { ...receipt, [field]: null } }))]) {
    assert.throws(() => qualificationArtifact(results(artifact), candidate), /does not match/);
  }
  assert.throws(() => qualificationArtifact({ total_count: 2, artifacts: [ok] }, candidate), /No unique/);
});

test("only expected HTTPS signed artifact hosts are accepted without bearer credentials", () => {
  const url = "https://storage.blob.core.windows.net/qualified?sig=fixture";
  assert.equal(qualificationDownloadUrl(url), url);
  for (const bad of ["http://storage.blob.core.windows.net/qualified", "https://storage.blob.core.windows.net.evil.test/z",
    "https://person@storage.blob.core.windows.net/z", "https://storage.blob.core.windows.net:8080/z"]) {
    assert.throws(() => qualificationDownloadUrl(bad), /Untrusted/);
  }
});

test("digest mismatch never reaches promotion and discards only the temporary artifact", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "topbot-artifact-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from("expected archive");
  await assert.rejects(downloadQualification({ ...candidate, root }, {
    read: async () => results(fixture(bytes)),
    download: async () => new Response("changed archive!"),
    use: () => assert.fail("A mismatched artifact reached promotion"),
    preflight: async () => {},
  }), /artifact (digest|exceeded)/);
  assert.deepEqual(await readdir(root), []);
});

test("extracts only the two expected Windows qualification files", { skip: process.platform !== "win32" }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "topbot-artifact-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const names = [`TopBot-${candidate.version}-x64.zip`, "topbot-windows-update.json"];
  for (const name of names) await writeFile(path.join(root, name), name);
  const tar = path.join(process.env.SystemRoot, "System32", "tar.exe");
  const archive = path.join(root, "fixture.zip");
  execFileSync(tar, ["-a", "-cf", archive, "-C", root, ...names], { windowsHide: true });
  const { readFile } = await import("node:fs/promises");
  const bytes = await readFile(archive);
  await downloadQualification({ ...candidate, root }, {
    read: async () => results(fixture(bytes)),
    download: async () => new Response(bytes),
    use: async dir => assert.deepEqual((await readdir(dir)).sort(), names.sort()),
    preflight: async () => {},
  });
  assert.deepEqual((await readdir(root)).sort(), [...names, "fixture.zip"].sort());
});
