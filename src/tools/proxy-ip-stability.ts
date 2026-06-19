import { chromium, type BrowserContext, type Page } from "patchright";
import { proxyForCarrier } from "../proxy.ts";

function usage(): never {
  console.error(`usage: proxy:ip-stability <carrier> [tracking-number] [--samples=N] [--country=us] [--session=id]

Checks whether a proxied browser context keeps the same public exit IP across repeated page requests.
For fedex, a tracking number also runs the real tracking page flow and samples IP around it.`);
  process.exit(2);
}

function flagValue(args: string[], name: string, fallback: string): string {
  const prefix = `${name}=`;
  const found = args.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

async function sampleIp(page: Page, label: string): Promise<{ label: string; ip?: string; error?: string }> {
  try {
    const body = await page.evaluate(async () => {
      const response = await fetch(`https://api.ipify.org?format=json&t=${Date.now()}`, {
        cache: "no-store",
      });
      return response.text();
    });
    const parsed = JSON.parse(body) as { ip?: string };
    return { label, ip: parsed.ip ?? body };
  } catch (err) {
    return { label, error: err instanceof Error ? err.message : String(err) };
  }
}

async function sampleIpViaNavigation(
  context: BrowserContext,
  label: string,
): Promise<{ label: string; ip?: string; error?: string }> {
  const page = await context.newPage();
  try {
    await page.goto(`https://api.ipify.org?format=json&t=${Date.now()}`, {
      waitUntil: "load",
      timeout: 30000,
    });
    const body = (await page.textContent("body")) ?? "";
    const parsed = JSON.parse(body) as { ip?: string };
    return { label, ip: parsed.ip ?? body };
  } catch (err) {
    return { label, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await page.close().catch(() => {});
  }
}

async function runFedExFlow(page: Page, trackingNumber: string) {
  const interestingRequests: Array<{ method: string; url: string }> = [];
  const interestingResponses: Array<{ status: number; url: string }> = [];

  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("fedex.com") || url.includes("api.fedex.com")) {
      interestingRequests.push({ method: request.method(), url });
    }
  });
  page.on("response", (response) => {
    const url = response.url();
    if (url.includes("fedex.com") || url.includes("api.fedex.com")) {
      interestingResponses.push({ status: response.status(), url });
    }
  });

  await page.goto("https://www.fedex.com/en-us/tracking.html", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForSelector("#trackingModuleTrackingNum", { timeout: 30000 });
  await page.fill("#trackingModuleTrackingNum", trackingNumber);
  await page.click("#btnSingleTrack, button[type='submit']");
  await page.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(12000);

  return {
    finalUrl: page.url(),
    shipmentResponses: interestingResponses.filter((entry) =>
      entry.url.includes("api.fedex.com/track/v2/shipments"),
    ),
    tokenResponses: interestingResponses.filter((entry) =>
      entry.url.includes("api.fedex.com/auth/oauth"),
    ),
    akamaiResponses: interestingResponses.filter(
      (entry) => entry.url.includes("/akam/") || /\/[A-Za-z0-9_-]{40,}/.test(new URL(entry.url).pathname),
    ),
    fedexRequestCount: interestingRequests.length,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const carrierId = positional[0];
  if (!carrierId) usage();

  const trackingNumber = positional[1];
  const samples = Number(flagValue(args, "--samples", "8"));
  const country = flagValue(args, "--country", process.env.PROXY_COUNTRY ?? "us");
  const session = flagValue(args, "--session", `${carrierId}-${Date.now()}`);
  const proxy = proxyForCarrier(carrierId, { country, session });
  if (!proxy) {
    console.error(`missing proxy env for ${carrierId}`);
    process.exit(2);
  }

  console.log(
    JSON.stringify(
      {
        proxy: {
          server: proxy.server,
          username: proxy.username,
          hasPassword: Boolean(proxy.password),
        },
        country,
        session,
      },
      null,
      2,
    ),
  );

  const browser = await chromium.launch({
    channel: carrierId === "fedex" || carrierId === "ups" ? "chrome" : undefined,
    headless: process.env.HEADLESS !== "false",
    proxy,
  });

  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("about:blank");

    const results: Array<{ label: string; ip?: string; error?: string }> = [];
    for (let i = 1; i <= samples; i += 1) {
      results.push(await sampleIp(page, `fetch_${i}`));
      await page.waitForTimeout(750);
    }

    for (let i = 1; i <= Math.min(samples, 5); i += 1) {
      results.push(await sampleIpViaNavigation(context, `navigation_${i}`));
    }

    let fedex:
      | Awaited<ReturnType<typeof runFedExFlow>>
      | { skipped: true; reason: string }
      | { error: string } = {
      skipped: true,
      reason: "carrier is not fedex or no tracking number was provided",
    };

    if (carrierId === "fedex" && trackingNumber) {
      results.push(await sampleIp(page, "before_fedex_flow"));
      try {
        fedex = await runFedExFlow(page, trackingNumber);
      } catch (err) {
        fedex = { error: err instanceof Error ? err.message : String(err) };
      }
      results.push(await sampleIp(page, "after_fedex_flow_same_page"));
      results.push(await sampleIpViaNavigation(context, "after_fedex_flow_new_page"));
    }

    const ips = results.filter((entry) => entry.ip).map((entry) => entry.ip);
    console.log(
      JSON.stringify(
        {
          stable: new Set(ips).size <= 1,
          uniqueIps: [...new Set(ips)],
          samples: results,
          fedex,
        },
        null,
        2,
      ),
    );

    await context.close().catch(() => {});
  } finally {
    await browser.close().catch(() => {});
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
