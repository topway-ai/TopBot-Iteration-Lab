import { expect, it, vi } from "vitest";
import { createUpdateChecker } from "./update-check.ts";

it("does not propose upstream releases for a TopBot build", async () => {
  const fetch = vi.fn();
  const check = createUpdateChecker({ current: "0.1.161-topbot.2", install: "git", fetch });
  expect(await check()).toMatchObject({ current: "0.1.161-topbot.2", available: false });
  expect(fetch).not.toHaveBeenCalled();
});
