import { appendFile, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export async function startIterationLab({ app, local, log }) {
  const root = process.env.TOPBOT_ITERATION_LAB_ROOT;
  if (!root || !/^D:\\TopBot-Release-Lab\\fixtures\\[a-z0-9-]+$/i.test(path.resolve(root))) return;
  if (!path.resolve(process.execPath).toLowerCase().startsWith(path.resolve(root).toLowerCase() + path.sep)) return;
  const command = path.join(root, "chat-command.json"), receipt = path.join(root, "chat-receipt.json");
  const get = async (url, method = "GET", body) => {
    const response = await local(url, { method, ...(body === undefined ? {} : {
      headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }) });
    if (!response.ok) throw new Error(`${method} ${url}: HTTP ${response.status}`);
    return response.json();
  };
  try {
    await appendFile(path.join(root, "launches.jsonl"), JSON.stringify({ version: app.getVersion(), pid: process.pid }) + "\n");
    const task = await readFile(command, "utf8").then(JSON.parse, error => error.code === "ENOENT" ? null : Promise.reject(error));
    if (task) {
      if (task.text !== "/topbot-iterate Change only the displayed label Pending to Ready in src/lib/RehearsalLabel.ts.") throw new Error("Unexpected lab chat command.");
      await rename(command, path.join(root, "chat-command.used.json"));
      const { bot } = await get("/api/bots", "POST", { name: "GitHub Release Rehearsal" });
      const threadId = bot.mainThreadId ?? bot.threadId;
      await get("/api/config", "PATCH", { profile: { name: "Synthetic Release Profile" } });
      const sent = await get(`/api/bots/${bot.id}/messages`, "POST", { text: task.text, threadId, mode: "chat", sendId: "isolation-release-once-001" });
      await writeFile(receipt, JSON.stringify({ botId: bot.id, threadId, userMessageId: sent.message.id, text: task.text }));
    }
    const saved = await readFile(receipt, "utf8").then(JSON.parse, error => error.code === "ENOENT" ? null : Promise.reject(error));
    if (saved) {
      const sample = async () => {
        const { messages } = await get(`/api/threads/${saved.threadId}/messages?limit=100`);
        const config = await get("/api/config");
        await writeFile(path.join(root, "observed-chat.json"), JSON.stringify({
          version: app.getVersion(), retainedSettings: config.profile?.name === "Synthetic Release Profile",
          messages: messages.map(({ id, role, text }) => ({ id, role, text })),
        }));
      };
      await sample();
      setInterval(() => void sample().catch(() => {}), 5000).unref?.();
    }
  } catch (error) {
    log(`Iteration fixture: ${error.message}`);
    await writeFile(path.join(root, "fixture-error.txt"), error.message).catch(() => {});
  }
}
