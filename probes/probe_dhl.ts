import { withPage, closeBrowser } from "./src/browser.ts";
import { writeFile } from "node:fs/promises";

const NUM = process.argv[2] ?? "00340434162530533196";

await withPage(async (page) => {
  const allResponses: { url: string; status: number; ct: string }[] = [];
  page.on("response", (r) => {
    allResponses.push({ url: r.url(), status: r.status(), ct: r.headers()["content-type"] || "" });
  });

  const URL = `https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=${NUM}`;
  console.log(`navigating to ${URL}`);
  await page.goto(URL, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(8000);

  const html = await page.content();
  await writeFile("dhl-page.html", html);
  console.log(`saved HTML (${html.length} bytes) to dhl-page.html`);

  await page.screenshot({ path: "dhl-page.png", fullPage: true });
  console.log("saved screenshot to dhl-page.png");

  console.log(`\nfinal URL: ${page.url()}`);
  console.log(`title: ${await page.title()}`);

  console.log(`\n=== all responses (${allResponses.length}) ===`);
  for (const r of allResponses) {
    if (!r.url.includes("dhl.de")) continue;
    console.log(`  ${r.status} ${r.ct.slice(0, 30).padEnd(30)} ${r.url}`);
  }

  console.log(`\n=== looking for sendungen markers in page text ===`);
  const bodyText = await page.evaluate(() => document.body.innerText);
  for (const marker of ["Sendungsdetails", "zugestellt", "in Zustellung", "Sendungsnummer nicht gefunden", "konnte nicht gefunden"]) {
    if (bodyText.includes(marker)) console.log(`  found: "${marker}"`);
  }
  console.log(`\nfirst 800 chars of body text:`);
  console.log(bodyText.slice(0, 800));
});

await closeBrowser();
