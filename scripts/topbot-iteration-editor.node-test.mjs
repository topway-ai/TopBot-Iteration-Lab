import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gitAt, reviewAutomaticSnapshot } from "./topbot-auto-review.mjs";
import { editWithDeepSeek, editWithLocalQwen } from "./topbot-iteration-editor.mjs";

async function fixture(t) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "topbot-editor-"));
  t.after(() => rm(workspace, { recursive: true, force: true, maxRetries: 3 }));
  const git = (args, io) => gitAt(workspace, args, { ...io, offline: true, isolated: true });
  git(["init", "-b", "main", "--template="]);
  for (const [key, value] of [["user.name", "Test"], ["user.email", "test@example.invalid"], ["core.autocrlf", "false"], ["commit.gpgSign", "false"]]) {
    git(["config", "--local", key, value]);
  }
  const file = "src/components/StatusLabel.tsx", write = (name, value) => writeFile(path.join(workspace, name), value);
  await mkdir(path.join(workspace, path.dirname(file)), { recursive: true });
  await write(file, 'export const label = "Status";\n');
  await write("package.json", '{"version":"0.1.161-topbot.9"}\n');
  git(["add", "."]);
  git(["commit", "-m", "Base"]);
  const base = git(["rev-parse", "HEAD"]).trim(), branch = "topbot-auto/editor-fixture";
  git(["checkout", "-b", branch]);
  await write(".gitignore", "local-secret.txt\n");
  git(["add", ".gitignore"]);
  git(["commit", "--amend", "--no-edit"]);
  const input = { workspace, base: git(["rev-parse", "HEAD"]).trim(), branch,
    task: "Change the label to Ready", version: "0.1.161-topbot.9" };
  assert.notEqual(input.base, base);
  await write("local-secret.txt", "fixture-local-secret");
  return { git, input, file, read: name => readFile(path.join(workspace, name), "utf8") };
}

const completion = data => Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(data) } }] });
const key = "fixture-inference-key", model = "deepseek/deepseek-v4-flash";

test("passes only pinned public source to a model without tools and commits the exact replacement", async t => {
  const f = await fixture(t);
  let calls = 0;
  await editWithDeepSeek(f.input, { key, model, request: async (url, init) => {
    assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(init.redirect, "error");
    assert.equal(init.headers.authorization, `Bearer ${key}`);
    assert.equal(init.body.includes(key), false);
    assert.equal(init.body.includes("fixture-local-secret"), false);
    const body = JSON.parse(init.body);
    assert.equal(body.model, model);
    assert.equal(body.provider.allow_fallbacks, false);
    assert.equal(body.tools, undefined);
    if (++calls === 1) return completion({ files: [f.file] });
    return completion({ edits: [{ path: f.file, before: '"Status"', after: '"Ready"' }] });
  } });
  assert.equal(calls, 2);
  assert.match(await f.read(f.file), /"Ready"/);
  assert.deepEqual(reviewAutomaticSnapshot(f.input.workspace, f.input.base, f.git(["rev-parse", "HEAD"]).trim()).files,
    ["package.json", f.file]);
});

test("rejects out-of-scope text edits before changing the worktree", async t => {
  const f = await fixture(t);
  f.input.task = `Change ${f.file}`;
  await assert.rejects(editWithDeepSeek(f.input, { key, model, request: async () => completion({ edits: [
    { path: f.file, before: '"Status"', after: '"Ready"' },
    { path: "../../Server.ts", before: "a", after: "b" },
  ] }) }), /out-of-scope/);
  assert.match(await f.read(f.file), /"Status"/);
  assert.equal(f.git(["rev-parse", "HEAD"]).trim(), f.input.base);
});

test("the offline editor targets the existing loopback Qwen without sending credentials", async t => {
  const f = await fixture(t);
  f.input.task = `Change ${f.file}`;
  await editWithLocalQwen(f.input, { key: "never sent", request: async (url, init) => {
    assert.equal(url, "http://127.0.0.1:8080/v1/chat/completions");
    assert.equal(init.headers.authorization, undefined);
    const body = JSON.parse(init.body);
    assert.equal(body.model, "qwen35-4b-uncensored");
    assert.equal(body.chat_template_kwargs.enable_thinking, false);
    assert.ok(body.max_tokens <= 384);
    return completion({ edits: [{ path: f.file, before: '"Status"', after: '"Ready"' }] });
  } });
  assert.match(await f.read(f.file), /"Ready"/);
});
