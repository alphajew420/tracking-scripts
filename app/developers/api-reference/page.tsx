import { MarketingChrome } from "@/components/marketing-shell";

const endpoints = [
  ["POST", "/v1/trackings", "Register one tracking number."],
  ["GET", "/v1/trackings/:id", "Read current state and event timeline."],
  ["POST", "/v1/trackings/bulk", "Register many tracking numbers."],
  ["POST", "/v1/trackings/lookup/bulk", "Synchronous fan-out lookup with row-level errors."],
  ["GET", "/v1/carriers/detect", "Return ordered carrier candidates."],
  ["POST", "/v1/webhooks/:id/test", "Send a signed test event."],
];

export default function Page() {
  return (
    <MarketingChrome>
      <section className="subpage-hero">
        <p className="eyebrow">API reference</p>
        <h1>Industry-standard REST shape for package visibility.</h1>
        <p>Bearer auth, JSON request/response bodies, stable IDs, snake_case fields, and ISO 8601 timestamps.</p>
      </section>
      <section className="endpoint-table">
        {endpoints.map(([method, path, copy]) => (
          <article key={path}>
            <b>{method}</b>
            <code>{path}</code>
            <span>{copy}</span>
          </article>
        ))}
      </section>
    </MarketingChrome>
  );
}
