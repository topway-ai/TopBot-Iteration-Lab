// No model here speaks video natively (OpenAI's chat-completions content parts are only "text" and "image_url",
// and a local vision model takes the same two); ffmpeg on PATH stands in by sampling stills from the clip.
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { TurnImageInput, TurnVideoInput } from "./contracts.ts";

export const VIDEO_SAMPLE_FRAME_COUNT = 4;
const FFPROBE_TIMEOUT_MS = 10_000;
const FFMPEG_TIMEOUT_MS = 20_000;
// Generous past any driver's turn timeout, so a slow tool loop still finds its frames; this is a leak bound, not a lease.
const FRAME_CLEANUP_DELAY_MS = 10 * 60 * 1000;
const runFile = promisify(execFile);
const LOCAL_CLIP_MAX_SECONDS = 60;

// Security invariant: an attachment comes from anyone who can reach a bot, and ffmpeg otherwise picks its reader from the
// file's contents, so a playlist named .mp4 could read other files or the network into a frame the model sees.
const VIDEO_READER: Record<TurnVideoInput["mime"], readonly string[]> = {
  "video/mp4": ["-protocol_whitelist", "file", "-f", "mov"],
  "video/quicktime": ["-protocol_whitelist", "file", "-f", "mov"],
  "video/webm": ["-protocol_whitelist", "file", "-f", "matroska"],
};

export type LocalVideoFrame = { at: number; jpeg: Buffer };

export async function localVideoSampler(video: TurnVideoInput, signal: AbortSignal) {
  const reader = VIDEO_READER[video.mime];
  const execOptions = { windowsHide: true, signal, maxBuffer: 1_000_000 };
  const metadata = await runFile("ffprobe", ["-v", "error", ...reader, "-select_streams", "v:0", "-show_entries",
    "stream=duration,avg_frame_rate:format=duration", "-of", "json", video.path],
  { ...execOptions, timeout: FFPROBE_TIMEOUT_MS }).then(({ stdout }) => JSON.parse(stdout) as {
    streams?: { duration?: string; avg_frame_rate?: string }[]; format?: { duration?: string };
  }).catch(() => {
    signal.throwIfAborted();
    throw new Error("TopBot could not read the video. Make sure FFmpeg and FFprobe are available and the file is playable.");
  });
  const stream = metadata.streams?.[0];
  const streamDuration = Number(stream?.duration);
  const duration = streamDuration > 0 ? streamDuration : Number(metadata.format?.duration);
  if (!stream || !Number.isFinite(duration) || duration <= 0) throw new Error("TopBot could not find a playable video stream.");
  if (duration > LOCAL_CLIP_MAX_SECONDS) throw new Error("For local Qwen, trim the video to 60 seconds or less and attach it again.");
  const [numerator = 0, denominator = 0] = (stream.avg_frame_rate ?? "").split("/").map(Number);
  const rate = numerator / denominator;
  const fps = Number.isFinite(rate) && rate > 0 ? Math.min(rate, 240) : 24;
  const last = Math.max(0, duration - 1.25 / fps);
  const extract = async (at: number): Promise<LocalVideoFrame> => {
    const candidates = at >= duration * 0.75 ? [at, duration * 0.9, duration * 0.75].filter(time => time <= at) : [at];
    for (const time of candidates) {
      const { stdout: jpeg } = await runFile("ffmpeg", ["-v", "error", "-nostdin", "-ss", time.toFixed(3), "-threads", "2",
        ...reader, "-i", video.path, "-map", "0:v:0", "-an", "-frames:v", "1", "-filter_threads", "1", "-threads", "1",
        "-vf", "scale=w='min(560,iw)':h='min(560,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
        "-q:v", "3", "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1"],
      { ...execOptions, timeout: FFMPEG_TIMEOUT_MS, encoding: "buffer" }).catch(() => {
        signal.throwIfAborted();
        throw new Error("TopBot could not extract a video frame. Try a short MP4 clip.");
      });
      if (jpeg.length) return { at: Number(time.toFixed(3)), jpeg };
    }
    throw new Error("TopBot could not extract a frame near the end of the clip.");
  };

  const cached = new Map<number, LocalVideoFrame>();
  return async (count: 3 | 7): Promise<LocalVideoFrame[]> => {
    const total = Math.max(1, Math.min(count, Math.round(duration * fps)));
    const unique = new Map<number, LocalVideoFrame>();
    for (let index = 0; index < total; index += 1) {
      signal.throwIfAborted();
      const at = Number((total === 1 ? 0 : (last * index) / (total - 1)).toFixed(3));
      let frame = cached.get(at);
      if (!frame) {
        frame = await extract(at);
        cached.set(at, frame);
      }
      unique.set(frame.at, frame);
    }
    return [...unique.values()].sort((a, b) => a.at - b.at);
  };
}

function run(command: string, args: readonly string[], timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk; });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk; });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(`${command} exited with code ${code}: ${stderr.trim().slice(-500)}`));
    });
  });
}

async function videoDurationSeconds(video: TurnVideoInput): Promise<number> {
  const stdout = await run(
    "ffprobe",
    ["-v", "error", ...VIDEO_READER[video.mime], "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", video.path],
    FFPROBE_TIMEOUT_MS,
  );
  const seconds = Number(stdout.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("ffprobe could not read this video's duration");
  return seconds;
}

async function extractFrame(video: TurnVideoInput, atSeconds: number, outPath: string): Promise<void> {
  await run("ffmpeg", [
    "-ss", atSeconds.toFixed(3),
    ...VIDEO_READER[video.mime],
    "-i", video.path,
    "-frames:v", "1",
    "-q:v", "4",
    "-vf", "scale=w='min(1024,iw)':h='min(1024,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
    "-y", outPath,
  ], FFMPEG_TIMEOUT_MS);
}

/**
 * Samples a handful of evenly spaced stills from an attached video so a model with only image input can see what
 * it contains. Frames live in their own temp directory, cleaned up on a delay rather than right after this call,
 * since the caller's driver still has to read each frame's path off disk later in the same turn. `limit` caps the
 * frames returned, so a turn's pictures plus frames never pass its image count.
 */
export async function videoFrameImages(videos: readonly TurnVideoInput[] | undefined, limit = Infinity): Promise<TurnImageInput[]> {
  if (!videos?.length || limit <= 0) return [];
  const frames: TurnImageInput[] = [];
  for (const video of videos) {
    if (frames.length >= limit) break;
    let dir: string | undefined;
    try {
      const duration = await videoDurationSeconds(video);
      const count = Math.min(VIDEO_SAMPLE_FRAME_COUNT, Math.max(1, Math.ceil(duration)), limit - frames.length);
      dir = await mkdtemp(join(tmpdir(), "omb-video-frame-"));
      for (let index = 0; index < count; index += 1) {
        const atSeconds = (duration * (index + 0.5)) / count;
        const outPath = join(dir, `frame-${index}.jpg`);
        await extractFrame(video, atSeconds, outPath);
        const bytes = await readFile(outPath);
        frames.push({ path: outPath, mime: "image/jpeg", bytes: bytes.byteLength, source: "video-frame" });
      }
    } catch {
      // ffmpeg/ffprobe missing, or a container this build cannot decode: the turn proceeds without this video's frames.
    } finally {
      if (dir) {
        const cleanup = dir;
        setTimeout(() => { void rm(cleanup, { recursive: true, force: true }); }, FRAME_CLEANUP_DELAY_MS);
      }
    }
  }
  return frames;
}
