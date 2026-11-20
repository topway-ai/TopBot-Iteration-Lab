import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { basename, join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { openHeadlessChrome } from "../scripts/testing/headless-chrome.ts";

const mediaDir = process.env.OMB_VERIFY_FFMPEG_DIR;
const live = process.env.OMB_QWEN_VIDEO_LLAMA_URL;
const ui = process.env.OMB_QWEN_VIDEO_UI;
const evidence = process.env.OMB_QWEN_VIDEO_EVIDENCE;
const qwen = "qwen35-4b-uncensored";
const standard = "fixture-cloud-model";

it.skipIf(!mediaDir)("uploads videos to TopBot and only resamples for the selected loopback Qwen", async () => {
  if (live && !/^http:\/\/127\.0\.0\.1:\d{1,5}\/v1$/.test(live)) throw new Error("Live verification only accepts a loopback llama.cpp URL.");
  const requests: Array<{ model: string; frames: number; stream: boolean; schema: boolean; question: string }> = [];
  const upstream = createServer(async (req, res) => {
    try {
      if (req.url === "/v1/models") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: [{ id: qwen }, { id: standard }] }));
        return;
      }
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
      const chunks: Uint8Array[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = JSON.parse(raw);
      const last = body.messages.at(-1).content;
      const parts = Array.isArray(last) ? last : [];
      const frames = parts.filter((part: { type: string }) => part.type === "image_url").length;
      const question = parts.filter((part: { type: string }) => part.type === "text").at(-1)?.text ?? last;
      requests.push({ model: body.model, frames, stream: body.stream, schema: Boolean(body.response_format), question });
      if (body.model === qwen) {
        if (live) {
          const actual = await fetch(live + "/chat/completions", { method: "POST", redirect: "error", headers: { "content-type": "application/json" }, body: raw });
          res.writeHead(actual.status, { "content-type": "application/json" }).end(await actual.text());
        } else {
          const dense = question.includes("0.65");
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
            needs_more_frames: dense && frames === 3, answer: dense ? frames === 3 ? "Need frames." : "\u84dd\u8272" : "\u7ea2\u8272",
          }) }, finish_reason: "stop" }], usage: { prompt_tokens: 500, completion_tokens: 10 } }));
        }
      } else {
        const delta = JSON.stringify({ choices: [{ index: 0, delta: { content: "Original cloud video route." }, finish_reason: "stop" }] });
        res.writeHead(200, { "content-type": "text/event-stream" }).end(`data: ${delta}\n\ndata: [DONE]\n\n`);
      }
    } catch (error) {
      res.writeHead(500).end(String(error));
    }
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("Missing provider port.");
  let fixture: Awaited<ReturnType<typeof launchVerificationServer>> | undefined;
  let page: Awaited<ReturnType<typeof openHeadlessChrome>> | undefined;
  try {
    fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, [], undefined, ui);
    const { url, logPath, dataDir } = fixture.info;
    const api = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(url + path, { method, headers: { origin: url, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const result = await response.json();
      expect(response.ok, JSON.stringify(result)).toBe(true);
      return result;
    };
    const control = (...args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
    await api("PATCH", "/api/config", { language: "en",
      onboarding: { completedAt: new Date().toISOString(), version: 1, reelSeen: true,
        hintsSeen: ["tour.composer", "tour.model", "tour.computer", "tour.computer-browser", "tour.tools", "tour.apps",
          "tour.apps-panel", "tour.automations", "tour.automations-page", "tour.done", "spot.composer", "spot.model", "spot.approval", "spot.connector"] },
      openaiCompat: { model: qwen, key: "synthetic-fixture-key", url: `http://127.0.0.1:${address.port}/v1` } });
    await api("POST", "/api/instances/openaiCompat/refresh-models", {});
    const listed = await api("GET", "/api/instances") as { instances: Array<{
      instanceId: string; models: { options: Array<{ id: string; videoReview?: true }> };
    }> };
    const offered = listed.instances.find(instance => instance.instanceId === "openaiCompat")?.models.options;
    expect(offered?.find(model => model.id === qwen)?.videoReview).toBe(true);
    expect(offered?.find(model => model.id === standard)?.videoReview).toBeUndefined();
    const newBot = async (name: string, model: string) => {
      const { bot } = await control("new-bot", "--name", name);
      await control("set-model", "--bot", bot.id, "--instance", "openaiCompat", "--model", model);
      await api("PATCH", `/api/bots/${bot.id}`, { computer: "off" });
      return bot as { id: string; activeTaskId: string };
    };
    const localBot = await newBot("Local video", qwen);
    const legacyBot = await newBot("Cloud video", standard);
    const clip = join(dataDir, "brief-blue.mp4");
    execFileSync(join(mediaDir!, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"), [
      "-v", "error", "-nostdin", "-f", "lavfi", "-i", "color=c=red:s=352x192:r=12:d=4",
      "-vf", "drawbox=x=0:y=0:w=iw:h=ih:color=blue:t=fill:enable='between(t,0.45,0.95)'",
      "-an", "-c:v", "libx264", "-threads", "2", "-pix_fmt", "yuv420p", clip,
    ], { windowsHide: true, timeout: 15_000 });
    if (ui) {
      page = await openHeadlessChrome(join(dataDir, "ephemeral-chrome"));
      const pairing = await api("POST", "/api/auth/pairing", { label: "Video verification browser" }) as { code: string };
      const paired = await fetch(`${url}/api/auth/pair`, { method: "POST", headers: { origin: url, "content-type": "application/json" },
        body: JSON.stringify({ code: pairing.code, label: "Video verification browser", cookie: true }) });
      expect(paired.ok).toBe(true);
      const cookie = paired.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
      const separator = cookie.indexOf("=");
      expect(separator).toBeGreaterThan(0);
      await page.send("Network.setCookie", { url, name: cookie.slice(0, separator), value: cookie.slice(separator + 1), httpOnly: true });
      await page.send("Page.addScriptToEvaluateOnNewDocument", { source: "localStorage.setItem('omb-analytics-opt-out','1');localStorage.setItem('omb-email-gate','skipped');localStorage.setItem('grok-move-2026-11','1');localStorage.setItem('modelgo-offer-2026-11','1');" });
      await page.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
      await page.send("Page.navigate", { url: `${url}/?thread=${localBot.activeTaskId}&bot=${localBot.id}` });
      await page.until("Boolean(document.querySelector('textarea[aria-label=\"Message Local video\"]'))");
    }
    const sendClip = async (bot: typeof localBot, question: string, browser = false) => {
      const start = performance.now();
      if (page && browser) {
        const selector = '[data-tour="composer"] input[type="file"]';
        const { root } = await page.send("DOM.getDocument");
        const { nodeId } = await page.send("DOM.querySelector", { nodeId: root.nodeId, selector });
        expect(nodeId).toBeGreaterThan(0);
        await page.send("DOM.setFileInputFiles", { nodeId, files: [clip] });
        await page.until(`Boolean(document.querySelector('button[aria-label="Remove file"]'))`, 20_000);
        await page.evaluate("document.querySelector('[data-tour=\"composer\"] textarea').focus()");
        await page.send("Input.insertText", { text: question });
        await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
        await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
        await page.until(`document.body.innerText.includes(${JSON.stringify(question)})`, 15_000);
      } else {
        const uploaded = await fetch(`${url}/api/files?name=${encodeURIComponent(basename(clip))}`, {
          method: "POST", headers: { origin: url, "content-type": "video/mp4" }, body: new Uint8Array(readFileSync(clip)),
        });
        expect(uploaded.status, await uploaded.clone().text()).toBe(201);
        const file = await uploaded.json() as { path: string };
        const text = `${question}\n\n<attached-file path="${file.path}" name="${basename(clip)}" />`;
        expect((await control("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", text)).success).toBe(true);
      }
      const settled = await control("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", live ? "180" : "30");
      const messages = await control("messages", "--bot", bot.id, "--task", bot.activeTaskId, "--limit", "12");
      expect(settled.status, JSON.stringify({ settled, messages, requests, logPath })).toBe("settled");
      return { seconds: Number(((performance.now() - start) / 1000).toFixed(2)), messages };
    };
    const sparse = await sendClip(localBot, "\u5f00\u5934\u7684\u753b\u9762\u662f\u4ec0\u4e48\u989c\u8272\uff1f\u53ea\u7528\u4e2d\u6587\u989c\u8272\u540d\u56de\u7b54\u3002", true);
    expect(JSON.stringify(sparse.messages)).toContain("\u7ea2\u8272");
    const dense = await sendClip(localBot, "\u5728\u7b2c 0.65 \u79d2\u9644\u8fd1\uff080.5 \u5230 0.9 \u79d2\uff09\uff0c\u6574\u4e2a\u753b\u9762\u662f\u4ec0\u4e48\u989c\u8272\uff1f\u9700\u8981\u8fd9\u4e2a\u65f6\u95f4\u6bb5\u5185\u7684\u4e00\u5f20\u5e27\u624d\u80fd\u5224\u65ad\uff1b\u6ca1\u6709\u5c31\u5148\u8bf7\u6c42\u8865\u5e27\u3002\u53ea\u7528\u4e2d\u6587\u989c\u8272\u540d\u56de\u7b54\u3002", true);
    expect(JSON.stringify(dense.messages)).toContain("\u84dd\u8272");
    const legacy = await sendClip(legacyBot, "Describe the attached video.");
    expect(JSON.stringify(legacy.messages)).toContain("Original cloud video route.");
    expect(requests.map(({ model, frames, stream, schema }) => [model, frames, stream, schema])).toEqual([
      [qwen, 3, false, true], [qwen, 3, false, true], [qwen, 7, false, true], [standard, 4, true, false],
    ]);
    expect(requests.filter(request => request.model === qwen).every(request => !request.question.includes("<attached-file"))).toBe(true);
    if (evidence) {
      mkdirSync(evidence, { recursive: true });
      if (page) {
        await page.until("document.body.innerText.includes('\u84dd\u8272')");
        writeFileSync(join(evidence, "video-chat.png"), await page.capture());
      }
      writeFileSync(join(evidence, "video-review.json"), JSON.stringify({ isolatedUrl: url, live: Boolean(live),
        renderer: Boolean(page), requests: requests.map(({ question: _question, ...request }) => request), sparse, dense, legacy, logPath }, null, 2));
    }
  } finally {
    page?.close();
    if (page) await new Promise(resolve => setTimeout(resolve, 650));
    await fixture?.close();
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
}, 300_000);
