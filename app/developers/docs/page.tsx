import Link from "next/link";
import { MarketingChrome } from "@/components/marketing-shell";

const guides = [
  ["Create a tracking", "POST /v1/trackings registers a package and schedules background monitoring."],
  ["Bulk register", "POST /v1/trackings/bulk accepts up to 40 rows on standard plans."],
  ["Receive webhooks", "Subscribe to tracking.updated, status_changed, delivered, exception, and expired."],
  ["Force retrack", "POST /v1/trackings/:id/retrack runs a rate-limited live refresh."],
];

const quickstart = `curl -X POST http://localhost:8788/v1/trackings \\
  -H "Authorization: Bearer test_or_live_api_key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "tracking_number": "TRACKING_NUMBER",
    "carrier": "ups",
    "custom_id": "ORDER_ID"
  }'`;

export default function Page() {
  return (
    <MarketingChrome>
      <section className="subpage-hero">
        <p className="eyebrow">Developers</p>
        <h1>Docs built around shipping events, not carrier trivia.</h1>
        <p>Use one normalized API for registration, lookup, webhooks, API keys, carrier detection, and account usage.</p>
      </section>
      <section className="doc-layout">
        <aside>
          <strong>Start here</strong>
          <Link href="/developers/api-reference">API reference</Link>
          <Link href="/developers/openapi">OpenAPI</Link>
          <Link href="/developers/sdks">SDKs</Link>
          <Link href="/developers/webhook-signing">Webhook signing</Link>
          <Link href="/developers/mcp-server">MCP server</Link>
        </aside>
        <div className="doc-cards">
          {guides.map(([title, copy]) => (
            <article key={title}>
              <h3>{title}</h3>
              <p>{copy}</p>
            </article>
          ))}
        </div>
      </section>
      <section className="docs-deep">
        <article className="api-panel standalone">
          <div className="panel-top"><span>quickstart</span><span>Bearer auth</span></div>
          <pre>{quickstart}</pre>
        </article>
        <div className="docs-reference-grid">
          <article>
            <h3>Authentication</h3>
            <p>Use `Authorization: Bearer live_...` or `test_...`. Dashboard sessions use secure HTTP-only cookies.</p>
          </article>
          <article>
            <h3>Rate limits</h3>
            <p>Limits apply per API key. Live retracks are separately protected at one retrack per minute per tracking.</p>
          </article>
          <article>
            <h3>Pagination</h3>
            <p>List endpoints should expose cursor pagination with filters for status, carrier, and date windows.</p>
          </article>
          <article>
            <h3>Errors</h3>
            <p>Return stable JSON errors with `code`, `message`, and optional `details` for row-level bulk failures.</p>
          </article>
        </div>
      </section>
    </MarketingChrome>
  );
}
