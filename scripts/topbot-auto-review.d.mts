/** Audit local commit objects without checking out or importing candidate code. Throws on rejection. */
export function reviewAutomaticSnapshot(cwd: string, base: string, head: string): {
  tree: string;
  files: string[];
  version: string;
};
