import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

function numberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isSafeTmpName(name: string): boolean {
  return (
    /^trackified-[a-z0-9-]+-profile(?:-|$)/i.test(name) ||
    /^trackified-[a-z0-9-]+-proxy(?:-|$)/i.test(name) ||
    /^trackified-surface-[a-z0-9-]+-/i.test(name) ||
    /^com\.google\.Chrome\./.test(name) ||
    /^\.com\.google\.Chrome\./.test(name) ||
    /^\.X\d+-lock$/.test(name)
  );
}

export interface BrowserTempCleanupResult {
  removed: number;
  failed: number;
}

export function cleanupBrowserTempArtifacts(options: {
  tmpDir?: string;
  maxAgeSeconds?: number;
} = {}): BrowserTempCleanupResult {
  const tmpDir = options.tmpDir ?? process.env.BROWSER_TMP_DIR ?? "/tmp";
  const maxAgeSeconds =
    options.maxAgeSeconds ?? numberEnv("BROWSER_TMP_MAX_AGE_SECONDS", 24 * 60 * 60);
  const cutoff = Date.now() - maxAgeSeconds * 1000;
  let removed = 0;
  let failed = 0;

  try {
    if (!existsSync(tmpDir)) return { removed, failed };
    for (const entry of readdirSync(tmpDir)) {
      if (!isSafeTmpName(entry)) continue;
      const path = join(tmpDir, entry);
      const stat = statSync(path);
      if (stat.mtimeMs > cutoff) continue;
      rmSync(path, { recursive: true, force: true });
      removed += 1;
    }
  } catch {
    failed += 1;
  }

  return { removed, failed };
}
