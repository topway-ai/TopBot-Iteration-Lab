import { describe, expect, it } from "vitest";
import { isLocalQwenVideoModel } from "./local-qwen-video.ts";

describe("local Qwen video opt-in", () => {
  it.each(["http://127.0.0.1:8080/v1", "http://localhost:8080/v1/", "http://[::1]:8080/v1"])("accepts the configured Qwen alias at %s", (url) => {
    expect(isLocalQwenVideoModel(url, "qwen35-4b-uncensored")).toBe(true);
    expect(isLocalQwenVideoModel(url, "deepseek/deepseek-v4.1-flash")).toBe(false);
  });

  it.each(["https://api.openai.com/v1", "https://openrouter.ai/api/v1", "http://192.168.0.2:8080/v1",
    "http://127.0.0.1.example.com/v1", "http://127.0.0.1/v1?forward=1", "http://127.0.0.1/v1/elsewhere"])("does not activate at %s", (url) => {
    expect(isLocalQwenVideoModel(url, "qwen35-4b-uncensored")).toBe(false);
  });
});
