import { MarketingChrome } from "@/components/marketing-shell";

const controls = ["Bearer live/test API keys", "Hashed API key storage", "HMAC webhook signatures", "Replay timestamp window", "Optional IP allowlists", "Per-key rate limits"];

export default function Page() {
  return (
    <MarketingChrome>
      <section className="subpage-hero">
        <p className="eyebrow">Security</p>
        <h1>Security controls for API customers and webhook receivers.</h1>
        <p>The MVP security model is deliberately boring: scoped keys, signed delivery, replay prevention, and rate limits.</p>
      </section>
      <section className="subpage-panel">
        <ul className="check-list">
          {controls.map((control) => <li key={control}>{control}</li>)}
        </ul>
      </section>
      <section className="security-grid">
        <article><h3>API keys</h3><p>Keys are shown once, hashed at rest, scoped by account, and split into test/live prefixes.</p></article>
        <article><h3>Webhook integrity</h3><p>Every delivery includes a timestamped HMAC signature so receivers can reject modified or replayed payloads.</p></article>
        <article><h3>Processing isolation</h3><p>Background shipment processing is isolated from public API request handling for clearer operational boundaries.</p></article>
        <article><h3>Auditability</h3><p>Webhook delivery records, API key metadata, and tracking timestamps give teams a clear operational trail.</p></article>
      </section>
    </MarketingChrome>
  );
}
