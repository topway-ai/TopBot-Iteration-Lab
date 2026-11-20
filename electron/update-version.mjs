/** True when candidate sorts above base, with a prerelease below its release. */
export function isNewerVersion(candidate, base) {
  if (typeof candidate !== "string" || typeof base !== "string") return false;
  const parse = (version) => {
    const [core, pre] = version.trim().replace(/^v/, "").split("+")[0].split(/-(.*)/s);
    return { nums: core.split(".").map((part) => Number.parseInt(part, 10) || 0), pre: pre ?? "" };
  };
  const a = parse(candidate);
  const b = parse(base);
  for (let i = 0; i < Math.max(a.nums.length, b.nums.length); i += 1) {
    const diff = (a.nums[i] ?? 0) - (b.nums[i] ?? 0);
    if (diff) return diff > 0;
  }
  if (a.pre === b.pre) return false;
  if (!a.pre) return true;
  if (!b.pre) return false;
  return a.pre.localeCompare(b.pre, "en", { numeric: true }) > 0;
}
