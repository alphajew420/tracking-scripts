import { withPage, closeBrowser } from "./src/browser.ts";

const NUM = process.argv[2] ?? "9400111899223816042167";

await withPage(async (page) => {
  const byType = new Map<string, { count: number; bytes: number }>();
  let totalBytes = 0;
  let totalCount = 0;

  page.on("response", async (resp) => {
    const ct = (resp.headers()["content-type"] || "other").split(";")[0].trim();
    let size = 0;
    try {
      const buf = await resp.body();
      size = buf.length;
    } catch {
      // resource might be a redirect or already closed
    }
    const entry = byType.get(ct) ?? { count: 0, bytes: 0 };
    entry.count += 1;
    entry.bytes += size;
    byType.set(ct, entry);
    totalBytes += size;
    totalCount += 1;
  });

  const t0 = Date.now();
  await page.goto(
    `https://tools.usps.com/go/TrackConfirmAction?qtc_tLabels1=${NUM}`,
    { waitUntil: "load", timeout: 60000 },
  );
  await page.waitForSelector(
    ".tracking-wrapper, .latest-update-banner-wrapper, .banner-header",
    { timeout: 20000 },
  );
  const elapsedMs = Date.now() - t0;

  const fmt = (b: number) =>
    b >= 1024 * 1024
      ? `${(b / 1024 / 1024).toFixed(2)} MB`
      : `${(b / 1024).toFixed(1)} KB`;

  const rows = Array.from(byType.entries()).sort((a, b) => b[1].bytes - a[1].bytes);

  console.log(`USPS query for ${NUM}`);
  console.log(`Elapsed: ${elapsedMs} ms`);
  console.log(`Total: ${totalCount} responses, ${fmt(totalBytes)}\n`);
  console.log(`By content-type:`);
  for (const [ct, { count, bytes }] of rows) {
    console.log(`  ${ct.padEnd(30)} ${String(count).padStart(3)}×  ${fmt(bytes)}`);
  }
});

await closeBrowser();
