import { execFileSync } from "node:child_process";
import { SessionPool } from "../workers/session-pool.ts";

function chromeSidecars(): string[] {
  try {
    const output = execFileSync("ps", ["-axo", "pid,lstart,command"], {
      encoding: "utf8",
    });
    return output
      .split("\n")
      .filter((line) => line.includes("remote-debugging-port"))
      .filter((line) => line.includes("cdp-fedex"))
      .filter((line) => line.includes("MacOS/Google Chrome") || line.includes("/usr/bin/google-chrome"))
      .filter((line) => !line.includes("Google Chrome Helper"))
      .filter((line) => !line.includes("grep"))
      .map((line) => line.trim());
  } catch {
    return [];
  }
}

function summarize(result: Awaited<ReturnType<SessionPool["track"]>>) {
  if (!result.ok || !result.track) {
    return { ok: false, error: result.error };
  }
  return {
    ok: true,
    status: result.track.delivered ? "delivered" : result.track.events[0]?.status ?? "unknown",
    events: result.track.events.length,
    first: result.track.events[0] ?? null,
  };
}

const numbers = process.argv.slice(2);
if (numbers.length === 0) {
  numbers.push("382150811542", "521355676935");
}

const rounds = Number(process.env.FEDEX_REPEAT_ROUNDS ?? 1);
const pool = new SessionPool();

console.log(JSON.stringify({
  rounds,
  numbers,
  env: {
    headless: process.env.HEADLESS ?? null,
    cdpAutoLaunch: process.env.BROWSER_CDP_AUTOLAUNCH_FEDEX ?? process.env.BROWSER_CDP_AUTOLAUNCH ?? null,
    profile: process.env.CDP_PROFILE_DIR_FEDEX ?? process.env.CDP_PROFILE_DIR ?? null,
    sessionMaxUsesFedex: process.env.SESSION_MAX_USES_FEDEX ?? null,
    proxyMode: process.env.PROXY_FEDEX_MODE ?? process.env.PROXY_MODE ?? null,
    hasProxyDefault: Boolean(process.env.PROXY_DEFAULT),
    hasProxyFedex: Boolean(process.env.PROXY_FEDEX),
  },
}, null, 2));

console.log("sidecars.before", JSON.stringify(chromeSidecars(), null, 2));

try {
  for (let round = 1; round <= rounds; round += 1) {
    for (const number of numbers) {
      const startedAt = Date.now();
      const result = await pool.track("fedex", number);
      const elapsedMs = Date.now() - startedAt;
      console.log(JSON.stringify({
        round,
        number,
        elapsedMs,
        result: summarize(result),
        sidecars: chromeSidecars(),
      }, null, 2));
    }
  }
} finally {
  await pool.close();
  console.log("sidecars.afterClose", JSON.stringify(chromeSidecars(), null, 2));
  process.exit(0);
}
