import Link from "next/link";
import {
  Activity,
  ArrowRight,
  CheckCircle2,
  Database,
  Globe2,
  KeyRound,
  PackageSearch,
  Radio,
  ServerCog,
  ShieldCheck,
  Truck,
  Webhook,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { comparisons, pricingPlans, productPages, solutionPages } from "@/lib/marketing";

const apiFeatures: Array<[LucideIcon, string, string]> = [
  [PackageSearch, "Shipment API", "Register, monitor, update, and retrieve package timelines through one normalized contract."],
  [Globe2, "Carrier network", "Identify likely carriers, normalize milestones, and keep multi-carrier shipments readable."],
  [Webhook, "Event delivery", "Push signed delivery events, retries, test sends, and failure visibility to customer systems."],
  [Radio, "Realtime operations", "Power support consoles, customer portals, widgets, and agent workflows from the same feed."],
];

const carrierGroups = [
  ["Global majors", "USPS, UPS, FedEx, DHL, DHL Express", "High-volume carrier coverage for core domestic and international shipments."],
  ["Postal networks", "Royal Mail, Canada Post, China Post, Japan Post", "National-post visibility for ecommerce, marketplaces, and inbound parcels."],
  ["Cross-border", "4PX, YunExpress, Cainiao, Yanwen", "Multi-leg shipment timelines across origin, customs, and last-mile carriers."],
  ["Regional carriers", "OnTrac, Evri, DPD, GLS, Australia Post", "Regional and last-mile coverage for support teams and merchant portals."],
];

const opsLanes: Array<[LucideIcon, string, string]> = [
  [KeyRound, "API edge", "Account-scoped keys, quotas, test/live modes, and customer-safe access controls."],
  [Database, "Delivery data plane", "Normalized shipment state, timelines, delivery windows, exceptions, and audit history."],
  [Workflow, "Event pipeline", "Scheduled refreshes, priority lookups, webhooks, retries, and customer notifications."],
  [Activity, "Health monitoring", "Carrier-level reliability, webhook success, queue latency, and operational alerts."],
  [ShieldCheck, "Enterprise controls", "Replay protection, signed payloads, usage limits, status pages, and incident visibility."],
];

export default function Home() {
  return (
    <main className="landing-page">
      <section className="landing-hero">
        <nav className="landing-nav" aria-label="Landing navigation">
          <Link href="/" className="brand">
            <span className="mark"><PackageSearch size={18} /></span>
            Trackified
          </Link>
          <div className="landing-nav-links">
            <Link href="/product/tracking-api">Product</Link>
            <Link href="/solutions/ecommerce">Solutions</Link>
            <Link href="/carriers">Carriers</Link>
            <Link href="/developers/docs">Docs</Link>
            <Link href="/pricing">Pricing</Link>
            <Link href="/login">Login</Link>
            <Link href="/dashboard" className="button primary">Dashboard</Link>
          </div>
        </nav>

        <div className="landing-hero-copy">
          <p className="eyebrow">Shipment visibility infrastructure</p>
          <h1>The delivery data layer for modern commerce and logistics teams.</h1>
          <p className="landing-lede">
            Trackified unifies carrier tracking, branded delivery pages, operational dashboards, signed webhooks,
            and developer APIs into one infrastructure platform.
          </p>
          <div className="actions">
            <Link href="/dashboard" className="button primary"><ArrowRight size={16} /> Open console</Link>
            <Link href="http://localhost:8788/openapi.json" className="button">View OpenAPI</Link>
          </div>
        </div>

        <div className="hero-console" aria-label="Live shipment summary">
          <div>
            <p className="eyebrow">Platform</p>
            <strong>API</strong>
            <span>tracking, carriers, webhooks</span>
          </div>
          <div>
            <p className="eyebrow">Network</p>
            <strong>200+</strong>
            <span>v1 carrier target</span>
          </div>
          <div>
            <p className="eyebrow">Delivery</p>
            <strong>Push</strong>
            <span>signed webhook events</span>
          </div>
        </div>
      </section>

      <section className="logo-wall" aria-label="Market proof">
        <span>Built to compete with the category leaders</span>
        <strong>17TRACK</strong>
        <strong>AfterShip</strong>
        <strong>TrackingMore</strong>
        <strong>Ship24</strong>
        <strong>Track123</strong>
      </section>

      <section className="api-theater" id="api">
        <div className="api-copy">
          <p className="eyebrow">API surface</p>
          <h2>One reliable contract over fragmented carrier data.</h2>
          <p>
            Register shipments, identify carriers, request priority refreshes, receive signed webhooks, and keep
            support teams on the same event timeline. The API is built for high-volume commerce systems, not one-off lookups.
          </p>
          <div className="endpoint-stack" aria-label="API endpoint examples">
            <span><b>POST</b> /v1/trackings</span>
            <span><b>POST</b> /v1/trackings/bulk</span>
            <span><b>GET</b> /v1/carriers/detect?number=...</span>
            <span><b>POST</b> /v1/webhooks/:id/test</span>
          </div>
        </div>
        <div className="api-panel" aria-label="Tracking API response preview">
          <div className="panel-top">
            <span>tracking.updated</span>
            <span>84ms cached</span>
          </div>
          <pre>{`{
  "tracking_number": "TRACKING_NUMBER",
  "carrier": "ups",
  "status": "in_transit",
  "next_update_at": "2026-06-07T22:00:00Z",
  "events": [
    {
      "status": "arrived_at_facility",
      "location": "LOCATION",
      "via_carrier": "ups"
    }
  ]
}`}</pre>
        </div>
      </section>

      <section className="capability-deck">
        {apiFeatures.map(([Icon, title, copy]) => (
          <article className="capability-card" key={String(title)}>
            <span><Icon size={20} /></span>
            <h3>{title}</h3>
            <p>{copy}</p>
          </article>
        ))}
      </section>

      <section className="suite-section">
        <div className="section-kicker">
          <p className="eyebrow">Product suite</p>
          <h2>Everything buyers expect from a serious visibility platform.</h2>
          <p>API, dashboard, white-label pages, webhooks, analytics, notifications, carrier detection, and enterprise deployment all point at one normalized shipment model.</p>
        </div>
        <div className="suite-grid">
          {productPages.map((page) => (
            <Link href={`/product/${page.slug}`} key={page.slug}>
              <span>{page.eyebrow}</span>
              <h3>{page.title}</h3>
              <p>{page.summary}</p>
            </Link>
          ))}
        </div>
      </section>

      <section className="coverage-board" id="coverage">
        <div className="coverage-intro">
          <p className="eyebrow">Carrier coverage</p>
          <h2>A carrier network designed to grow with global shipment volume.</h2>
          <p>
            Trackified gives teams a single carrier directory with coverage status, regions, service categories,
            and normalized tracking semantics across global, postal, regional, and cross-border networks.
          </p>
        </div>
        <div className="carrier-matrix">
          {carrierGroups.map(([title, carriers, copy]) => (
            <article key={title}>
              <div>
                <CheckCircle2 size={16} />
                <strong>{title}</strong>
              </div>
              <p className="carrier-line">{carriers}</p>
              <p>{copy}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="how-it-works">
        <div>
          <p className="eyebrow">How it works</p>
          <h2>Register once. We monitor until delivery.</h2>
        </div>
        <article><span>01</span><h3>Create tracking</h3><p>Send a tracking number and optional carrier. Auto-detect fills in likely candidates when missing.</p></article>
        <article><span>02</span><h3>Monitor intelligently</h3><p>The platform refreshes shipment state based on delivery phase, priority, and account limits.</p></article>
        <article><span>03</span><h3>Push updates</h3><p>Events update the dashboard, public pages, API reads, and signed webhook subscribers.</p></article>
      </section>

      <section className="ops-command" id="ops">
        <div className="ops-copy">
          <p className="eyebrow">Infrastructure layer</p>
          <h2>Built for real shipment operations, not a lookup widget.</h2>
          <p>
            Trackified separates customer-facing APIs from delivery-event processing, keeping reads fast, updates
            reliable, and operational issues visible before they become support escalations.
          </p>
        </div>
        <div className="ops-rail">
          {opsLanes.map(([Icon, title, copy], index) => (
            <article key={title}>
              <span className="step">0{index + 1}</span>
              <Icon size={19} />
              <strong>{title}</strong>
              <p>{copy}</p>
            </article>
          ))}
        </div>
        <div className="proof-bar" aria-label="Operational proof points">
          <div><ServerCog size={18} /><strong>Postgres</strong><span>source of truth</span></div>
          <div><Activity size={18} /><strong>Redis/BullMQ</strong><span>queue + locks</span></div>
          <div><Truck size={18} /><strong>Carrier network</strong><span>global coverage</span></div>
          <div><Radio size={18} /><strong>Agents</strong><span>MCP-ready path</span></div>
        </div>
      </section>

      <section className="solutions-section">
        <div className="section-kicker">
          <p className="eyebrow">Solutions</p>
          <h2>Positioned for ecommerce, logistics, support, resellers, and AI operators.</h2>
        </div>
        <div className="solution-list">
          {solutionPages.map((page) => (
            <Link href={`/solutions/${page.slug}`} key={page.slug}>
              <strong>{page.title}</strong>
              <span>{page.summary}</span>
            </Link>
          ))}
        </div>
      </section>

      <section className="pricing-preview">
        <div>
          <p className="eyebrow">Pricing preview</p>
          <h2>Clear tiers now, usage-based lanes when volume gets real.</h2>
          <Link href="/pricing" className="button primary">View pricing</Link>
        </div>
        <div className="mini-pricing">
          {pricingPlans.map(([name, price, trackings]) => (
            <article key={name}>
              <span>{name}</span>
              <strong>{price}</strong>
              <small>{trackings}</small>
            </article>
          ))}
        </div>
      </section>

      <section className="compare-preview">
        <div className="section-kicker">
          <p className="eyebrow">Competitive position</p>
          <h2>Match the expected surface, then beat closed systems on deployability and AI-native workflows.</h2>
        </div>
        <div className="compare-links">
          {Object.entries(comparisons).map(([slug, comparison]) => (
            <Link href={`/compare/${slug}`} key={slug}>
              <span>Compare</span>
              <strong>{comparison.name}</strong>
              <p>{comparison.thesis}</p>
            </Link>
          ))}
        </div>
      </section>

      <section className="final-cta">
        <p className="eyebrow">Build the tracking layer</p>
        <h2>Ship the API, dashboard, and white-label tracking experience from one shipment visibility platform.</h2>
        <div className="actions">
          <Link href="/signup" className="button primary">Start free</Link>
          <Link href="/developers/docs" className="button">Read docs</Link>
        </div>
      </section>
    </main>
  );
}
