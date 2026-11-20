import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runUpdateHelper } from "../topbot-managed-update.mjs";

const job = path.resolve(process.argv[2]);
const plan = JSON.parse(await readFile(path.join(job, "plan.json"), "utf8"));
const child = await runUpdateHelper(job, "Apply", { detached: true,
  spawnImpl: (executable, args, options) => spawn(executable, [...args, "-NoRecoveryRegistration", "-ProbeSeconds", "1", "-TimeoutSeconds", "30"], options) });
let handedOff = false;
for (let i = 0; i < 100; i++) {
  const ready = await readFile(path.join(job, "helper-ready.json"), "utf8").then(JSON.parse).catch(() => null);
  if (ready?.pid === child.pid && ready.token === plan.token) {
    await writeFile(path.join(job, "go.json"), JSON.stringify({ token: plan.token, pid: child.pid }));
    handedOff = true;
    break;
  }
  if (child.exitCode != null) throw new Error(`Helper exited (${child.exitCode}).`);
  await new Promise(resolve => setTimeout(resolve, 100));
}
if (!handedOff) throw new Error("Helper handoff timed out.");
console.log("Parent is exiting before update completion.");
