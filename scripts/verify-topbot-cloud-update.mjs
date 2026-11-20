import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { githubOwner } from "./topbot-iteration.mjs";
import { downloadQualification } from "./topbot-qualification-artifact.mjs";
import { releaseAssets } from "./publish-topbot-windows.mjs";

const [runNumber, head, branch, version, oldApplication] = process.argv.slice(2);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scratch = path.resolve(process.env.TOPBOT_LOCAL_BUILD_SCRATCH ?? path.join(root, ".omb-scratch"));
const run = Number(runNumber);
assert.ok(Number.isSafeInteger(run) && run > 0 && /^[a-f0-9]{40}$/.test(head) &&
  /^topbot-(auto|dev)\/[a-z0-9-]{1,40}$/.test(branch) && path.isAbsolute(oldApplication),
"Use <run-id> <commit-sha> <candidate-branch> <version> <absolute-old-app-path>.");
const request = await githubOwner(root);
const info = await request(`/repos/topway-ai/TopBot-Iteration-Lab/actions/runs/${run}`);
assert.ok(info.id === run && info.head_sha === head && info.head_branch === branch &&
  info.event === "workflow_dispatch" && info.path?.split("@", 1)[0] === ".github/workflows/topbot-windows-update.yml" &&
  info.status === "completed" && info.conclusion === "success" && info.run_attempt === 1, "The exact artifact-only qualification has not succeeded.");
await downloadQualification({ run, head, branch, version, root: scratch }, { read: request, download: request.download,
  use: async archive => {
    await releaseAssets(archive, version);
    console.log(JSON.stringify({ run, head, branch, version, downloadedAndVerified: true }));
    const qualify = (...testOptions) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(root, "scripts", "verify-topbot-update-package.mjs"), archive, oldApplication,
        "--hidden-candidate", "--qualified-archive-only", ...testOptions], { stdio: "inherit", windowsHide: true });
      child.once("error", reject);
      child.once("exit", code => code === 0 ? resolve() : reject(new Error(`Isolated Windows package test ended with ${code}.`)));
    });
    await qualify("--rollback-check");
    await qualify("--inject-health-timeout");
  },
});
