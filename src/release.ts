import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const ENV_KEYS = [
  "ERRORGAP_RELEASE",
  "SOURCE_VERSION",
  "HEROKU_SLUG_COMMIT",
  "HEROKU_BUILD_COMMIT",
  "RENDER_GIT_COMMIT",
  "RAILWAY_GIT_COMMIT_SHA",
  "VERCEL_GIT_COMMIT_SHA",
  "KAMAL_VERSION",
  "GIT_COMMIT",
  "GIT_SHA",
];

/**
 * Works out which commit is running when `release` is not configured, so
 * errors are attributed to a deploy without any setup: the commit variables
 * hosting platforms export, then the checkout's `.git/HEAD`.
 */
export function detectRelease(
  rootDirectory: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  for (const key of ENV_KEYS) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  try {
    return gitHead(rootDirectory);
  } catch {
    return undefined;
  }
}

function gitHead(root: string): string | undefined {
  let git = join(root, ".git");
  let head = read(join(git, "HEAD"));
  if (head === undefined) {
    // A worktree or submodule has a `.git` file pointing at the real dir.
    const pointer = read(git)?.match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
    if (!pointer) return undefined;
    git = isAbsolute(pointer) ? pointer : resolve(root, pointer);
    head = read(join(git, "HEAD"));
    if (head === undefined) return undefined;
  }
  const ref = head.match(/^ref:\s*(.+)$/)?.[1];
  if (!ref) return sha(head);

  const loose = read(join(git, ref));
  if (loose !== undefined) return sha(loose);
  const packed = read(join(git, "packed-refs"));
  const line = packed?.split("\n").find((entry) => entry.trim().endsWith(` ${ref}`));
  return line ? sha(line.trim().split(" ")[0] ?? "") : undefined;
}

function read(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return undefined;
  }
}

function sha(value: string): string | undefined {
  return /^[0-9a-f]{7,64}$/i.test(value) ? value : undefined;
}
