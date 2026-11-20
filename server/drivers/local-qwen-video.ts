import type { SendTurnInput } from "../contracts.ts";
import { localVideoSampler } from "../turn-video.ts";

const LOCAL_REVIEW_TIMEOUT_MS = 240_000;
const schema = {
  type: "object",
  properties: { answer: { type: "string" }, needs_more_frames: { type: "boolean" } },
  required: ["answer", "needs_more_frames"],
  additionalProperties: false,
};

export function isLocalQwenVideoModel(apiUrl: string, model: string): boolean {
  if (model !== "qwen35-4b-uncensored") return false;
  try {
    const url = new URL(apiUrl);
    return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      && (url.protocol === "http:" || url.protocol === "https:")
      && url.pathname.replace(/\/+$/, "") === "/v1"
      && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

type ReviewResponse = {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

export async function reviewLocalQwenVideo(input: NonNullable<SendTurnInput["videoReview"]>, options: {
  apiUrl: string; apiKey: string; model: string; signal: AbortSignal;
  onPass: (frameCount: number) => void;
}): Promise<{ answer: string; usage: { input: number; output: number } }> {
  if (!isLocalQwenVideoModel(options.apiUrl, options.model)) throw new Error("Video review requires the local Qwen endpoint.");
  const question = input.question || "Briefly describe the main action shown in the video.";
  if (question.length > 500) throw new Error("For local Qwen video analysis, keep the question under 500 characters.");
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(LOCAL_REVIEW_TIMEOUT_MS)]);
  const sample = await localVideoSampler(input.video, signal);
  const usage = { input: 0, output: 0 };
  const ask = async (frames: Awaited<ReturnType<typeof sample>>, final: boolean) => {
    const system = "Analyze only the supplied still frames in chronological order. Answer in the language of the question. Do not guess facts not visible in them. If the requested detail, brief event, or time interval cannot be verified from the frames, set needs_more_frames to true and say briefly what is missing. Otherwise set it to false. Do not infer absence throughout the clip from a few snapshots. " +
      (final ? "This is the final pass. State any uncertainty plainly." : "More frames can be sampled if needed.");
    const content = frames.flatMap(({ at, jpeg }) => [
      { type: "text", text: `Frame near ${at.toFixed(2)} seconds` },
      { type: "image_url", image_url: { url: `data:image/jpeg;base64,${jpeg.toString("base64")}` } },
    ]);
    content.push({ type: "text", text: question });
    options.onPass(frames.length);
    const response = await fetch(`${options.apiUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST", redirect: "error", signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
      body: JSON.stringify({ model: options.model, messages: [{ role: "system", content: system }, { role: "user", content }],
        stream: false, temperature: 0, seed: 42, max_tokens: 256, cache_prompt: false,
        chat_template_kwargs: { enable_thinking: false },
        response_format: { type: "json_schema", json_schema: { name: "video_answer", strict: true, schema } } }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Local Qwen video request failed (HTTP ${response.status}). Verify that llama.cpp is running with the Qwen vision projector.`);
    }
    const reply = await response.json() as ReviewResponse;
    const choice = reply.choices?.[0];
    if (!choice?.message?.content || choice.finish_reason !== "stop") throw new Error("Local Qwen did not finish the video answer.");
    let result: { answer?: unknown; needs_more_frames?: unknown } | null;
    try { result = JSON.parse(choice.message.content); }
    catch { throw new Error("Local Qwen returned an invalid video answer."); }
    if (typeof result?.answer !== "string" || !result.answer.trim() || typeof result.needs_more_frames !== "boolean") {
      throw new Error("Local Qwen returned an invalid video answer.");
    }
    usage.input += reply.usage?.prompt_tokens ?? 0;
    usage.output += reply.usage?.completion_tokens ?? 0;
    return { answer: result.answer.trim(), needsMore: result.needs_more_frames };
  };

  const sparse = await sample(3);
  let result = await ask(sparse, false);
  if (result.needsMore) {
    const dense = await sample(7);
    if (dense.some(frame => !sparse.some(previous => previous.at === frame.at))) result = await ask(dense, true);
  }
  return { answer: result.answer, usage };
}
