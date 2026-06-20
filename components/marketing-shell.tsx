import Link from "next/link";
import { ArrowRight, PackageSearch } from "lucide-react";

const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? "https://api.trackified.15-204-158-166.sslip.io";

const nav = [
  ["Product", "/product/tracking-api"],
  ["Solutions", "/solutions/ecommerce"],
  ["Carriers", "/carriers"],
  ["Developers", "/developers/docs"],
  ["Pricing", "/pricing"],
  ["Security", "/security"],
];

export function MarketingNav() {
  return (
    <nav className="marketing-nav" aria-label="Main navigation">
      <Link href="/" className="brand">
        <span className="mark"><PackageSearch size={18} /></span>
        Trackified
      </Link>
      <div className="marketing-links">
        {nav.map(([label, href]) => <Link key={href} href={href}>{label}</Link>)}
      </div>
      <div className="marketing-actions">
        <Link href="/login">Login</Link>
        <Link href="/signup" className="button primary">Start free</Link>
      </div>
    </nav>
  );
}

export function MarketingFooter() {
  return (
    <footer className="marketing-footer">
      <div className="footer-brand">
        <Link href="/" className="brand">
          <span className="mark"><PackageSearch size={18} /></span>
          Trackified
        </Link>
        <p>Shipment visibility infrastructure for stores, resellers, 3PLs, support teams, and AI agents.</p>
        <span>API: {apiBase.replace(/^https?:\/\//, "")}</span>
      </div>
      <div className="footer-columns">
        <div>
          <strong>Product</strong>
          <Link href="/product/tracking-api">Tracking API</Link>
          <Link href="/product/webhooks">Webhooks</Link>
          <Link href="/product/white-label-tracking">White-label pages</Link>
          <Link href="/product/carrier-detection">Carrier detection</Link>
        </div>
        <div>
          <strong>Solutions</strong>
          <Link href="/solutions/ecommerce">Ecommerce</Link>
          <Link href="/solutions/logistics-3pl">3PL logistics</Link>
          <Link href="/solutions/resellers">Resellers</Link>
          <Link href="/solutions/ai-agents">AI agents</Link>
        </div>
        <div>
          <strong>Developers</strong>
          <Link href="/developers/docs">Docs</Link>
          <Link href="/developers/api-reference">API reference</Link>
          <Link href="/developers/openapi">OpenAPI</Link>
          <Link href="/developers/webhook-signing">Webhook signing</Link>
        </div>
        <div>
          <strong>Company</strong>
          <Link href="/pricing">Pricing</Link>
          <Link href="/carriers">Carriers</Link>
          <Link href="/security">Security</Link>
          <Link href="/status">Status</Link>
          <Link href="/changelog">Changelog</Link>
        </div>
      </div>
    </footer>
  );
}

export function MarketingChrome({ children }: { children: React.ReactNode }) {
  return (
    <main className="marketing-page">
      <MarketingNav />
      {children}
      <MarketingFooter />
    </main>
  );
}

export function GenericMarketingPage({ page }: { page: { eyebrow: string; title: string; summary: string; bullets: string[]; proof: string } }) {
  const endpoint = page.title.toLowerCase().includes("webhook") ? "/v1/webhooks" : page.title.toLowerCase().includes("carrier") ? "/v1/carriers/detect" : "/v1/trackings";

  return (
    <MarketingChrome>
      <section className="subpage-hero rich">
        <div>
          <p className="eyebrow">{page.eyebrow}</p>
          <h1>{page.title}</h1>
          <p>{page.summary}</p>
          <div className="actions">
            <Link href="/signup" className="button primary">Start free <ArrowRight size={15} /></Link>
            <Link href="/developers/docs" className="button">Read docs</Link>
          </div>
        </div>
        <aside className="hero-proof-card">
          <span>Production shape</span>
          <strong>{endpoint}</strong>
          <p>{page.proof}</p>
        </aside>
      </section>

      <section className="page-proof-strip">
        <div><strong>Push</strong><span>signed webhook events</span></div>
        <div><strong>200+</strong><span>v1 carrier coverage target</span></div>
        <div><strong>40</strong><span>bulk rows on standard plans</span></div>
        <div><strong>2,000+</strong><span>registry-scale carrier target</span></div>
      </section>

      <section className="deep-feature-grid">
        {page.bullets.map((bullet, index) => (
          <article key={bullet}>
            <span>0{index + 1}</span>
            <h3>{bullet}</h3>
            <p>Built into the same normalized tracking model, so dashboard views, API responses, webhooks, and public pages stay consistent.</p>
          </article>
        ))}
      </section>

      <section className="workflow-section">
        <div>
          <p className="eyebrow">Workflow</p>
          <h2>How {page.title.toLowerCase()} fits into the platform.</h2>
        </div>
        <article><span>01</span><h3>Ingest</h3><p>Receive a tracking number, account context, carrier candidate, or customer-facing event request.</p></article>
        <article><span>02</span><h3>Normalize</h3><p>Map carrier-specific fields into status, event timeline, delivery estimate, and exception semantics.</p></article>
        <article><span>03</span><h3>Distribute</h3><p>Update cached reads, dashboard surfaces, public pages, webhooks, notifications, and agent tools.</p></article>
      </section>

      <section className="implementation-band">
        <div>
          <p className="eyebrow">Implementation</p>
          <h2>Designed for teams migrating from 17TRACK-style APIs.</h2>
          <p>Use stable IDs, account-scoped keys, bulk endpoints, signed webhooks, and carrier detection without sending customers outside your product experience.</p>
        </div>
        <pre>{`await tracking.trackings.create({
  tracking_number: "TRACKING_NUMBER",
  carrier: "ups",
  custom_id: "ORDER_ID"
});`}</pre>
      </section>

      <section className="faq-section">
        <article><h3>Does this require every carrier integration upfront?</h3><p>No. The public API stays consistent while carrier coverage expands behind the platform.</p></article>
        <article><h3>How do teams handle urgent updates?</h3><p>Use priority refresh endpoints and status-driven monitoring windows for shipments that need immediate attention.</p></article>
        <article><h3>Can this be self-hosted?</h3><p>Yes. The stack is designed around Docker, Postgres, Redis, API services, and background processing.</p></article>
      </section>

      <section className="cta-panel">
        <div>
          <p className="eyebrow">Next step</p>
          <h2>Plug this into the same API, webhook, and dashboard system.</h2>
        </div>
        <Link href="/signup" className="button primary">Start building</Link>
      </section>
    </MarketingChrome>
  );
}
