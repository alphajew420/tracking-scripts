import { notFound } from "next/navigation";
import { CarrierIntake } from "@/components/carrier-intake";
import { MarketingChrome } from "@/components/marketing-shell";
import { getCarrierValidation } from "@/lib/carrier-validation";
import { carriers } from "@/lib/marketing";

export function generateStaticParams() {
  return carriers
    .filter((carrier) => carrier.status === "Live coverage")
    .map((carrier) => ({ "carrier-id": carrier.id }));
}

export async function generateMetadata({ params }: { params: Promise<{ "carrier-id": string }> }) {
  const resolvedParams = await params;
  const carrier = carriers.find((item) => item.id === resolvedParams["carrier-id"]);
  if (!carrier || carrier.status !== "Live coverage") return {};
  return {
    title: `${carrier.name} Tracking API, Webhooks, and Carrier Coverage | Trackified`,
    description: `${carrier.name} shipment visibility for ${carrier.region}: services, tracking formats, event coverage, delivery updates, webhooks, and API integration guidance.`,
  };
}

export default async function Page({ params }: { params: Promise<{ "carrier-id": string }> }) {
  const resolvedParams = await params;
  const carrier = carriers.find((item) => item.id === resolvedParams["carrier-id"]);
  if (!carrier || carrier.status !== "Live coverage") notFound();
  const validation = getCarrierValidation(carrier.id);
  const relatedCarriers = carriers
    .filter((item) => item.id !== carrier.id && (item.tier === carrier.tier || item.region === carrier.region || item.status === carrier.status))
    .slice(0, 3);
  const primaryService = carrier.services[0];
  const primaryEvent = carrier.eventCoverage[0];

  return (
    <MarketingChrome>
      <section className="carrier-profile-hero">
        <div>
          <p className="eyebrow">{carrier.tier}</p>
          <h1>{carrier.name}</h1>
          <p>{carrier.summary}</p>
          <div className="carrier-badges">
            <span>{carrier.status}</span>
            <span>{carrier.region}</span>
            <span>{carrier.services.length} service families</span>
            <span>{carrier.eventCoverage.length} event types</span>
          </div>
        </div>
        <aside>
          <span>Coverage status</span>
          <strong>{carrier.status}</strong>
          <p>{carrier.launchStage}</p>
        </aside>
      </section>

      <CarrierIntake carrierId={carrier.id} carrierName={carrier.name} validationStatus={validation.status} />

      <section className="carrier-longform">
        <article>
          <p className="eyebrow">Overview</p>
          <h2>{carrier.name} tracking infrastructure for {carrier.region} shipments</h2>
          <p>
            {carrier.name} is part of the Trackified carrier network for teams that need package visibility inside
            their own products, dashboards, customer portals, and operational workflows. Instead of asking support
            agents or buyers to interpret carrier-specific pages, Trackified presents {carrier.name} milestones through
            a consistent shipment model with status, service level, location, timestamp, delivery phase, and exception
            context.
          </p>
          <p>
            This page documents how {carrier.name} coverage is represented in Trackified: supported service families,
            common tracking-number formats, event coverage, monitoring coverage, and the workflows where this
            carrier is most useful. The goal is to make carrier coverage understandable before a team builds order
            tracking, webhook automation, support triage, or post-purchase messaging on top of it.
          </p>
        </article>
        <aside>
          <strong>{carrier.status}</strong>
          <span>{carrier.launchStage}</span>
          <p>{carrier.reliability}</p>
        </aside>
      </section>

      <section className="carrier-profile-grid">
        <article className="carrier-profile-panel large">
          <p className="eyebrow">Reliability notes</p>
          <h2>{carrier.reliability}</h2>
          <p>{carrier.updateCadence}</p>
          <div className={`carrier-status-chip ${validation.status}`} style={{ marginTop: 18 }}>
            <span />
            <strong>{validation.status.replaceAll("_", " ")}</strong>
          </div>
          <p style={{ marginTop: 14 }}>{validation.result}</p>
        </article>
        <article className="carrier-profile-panel">
          <p className="eyebrow">Services</p>
          <ul>{carrier.services.map((item) => <li key={item}>{item}</li>)}</ul>
        </article>
        <article className="carrier-profile-panel">
          <p className="eyebrow">Tracking formats</p>
          <ul>{carrier.formats.map((item) => <li key={item}>{item}</li>)}</ul>
        </article>
      </section>

      <section className="carrier-copy-grid">
        <article>
          <h2>What {carrier.name} coverage includes</h2>
          <p>
            Trackified models {carrier.name} shipments around service level, delivery phase, carrier events, and customer
            communication needs. For {carrier.region} shipments, this means a support team can see whether a package is
            newly registered, moving through the network, waiting for destination processing, out for delivery, delivered,
            or blocked by an exception.
          </p>
          <p>
            The most important difference between raw carrier tracking and infrastructure-grade tracking is consistency.
            A merchant, 3PL, reseller, or marketplace should not need to rewrite its order status logic for every carrier.
            {carrier.name} events are normalized into the same model used by the Trackified API, dashboard, branded
            tracking pages, webhook payloads, and agent tools.
          </p>
        </article>
        <article>
          <h2>Best-fit workflows</h2>
          <p>
            {carrier.name} is especially useful for {carrier.bestFor.join(", ").toLowerCase()}. These workflows need more
            than a final delivery confirmation: they need predictable status transitions, exception visibility, and
            customer-safe language that can be shown inside a merchant or logistics portal.
          </p>
          <p>
            Trackified keeps those workflows connected by using one delivery data layer. A single {carrier.name} update
            can refresh the operations dashboard, update a white-label tracking page, trigger a signed webhook, and
            give support agents a cleaner answer for customers asking where their package is.
          </p>
        </article>
      </section>

      <section className="carrier-event-map">
        <div>
          <p className="eyebrow">Event coverage</p>
          <h2>Normalized milestones for product, support, and customer-facing workflows.</h2>
        </div>
        <div>
          {carrier.eventCoverage.map((event) => <span key={event}>{event}</span>)}
        </div>
      </section>

      <section className="carrier-event-deep">
        <div>
          <p className="eyebrow">Event semantics</p>
          <h2>How {carrier.name} milestones become product-ready statuses.</h2>
          <p>
            Carrier events are useful only when downstream systems can reason about them. Trackified groups
            {carrier.name} events into customer-safe delivery states such as pending, in transit, out for delivery,
            delivered, exception, and expired. Raw descriptions are preserved where useful, but product workflows should
            rely on normalized status values and timestamps.
          </p>
        </div>
        <div>
          {carrier.eventCoverage.map((event, index) => (
            <article key={event}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <h3>{event}</h3>
              <p>
                Trackified maps this {carrier.name} milestone into the package timeline with consistent status,
                description, location, and delivery-phase fields.
              </p>
            </article>
          ))}
        </div>
      </section>

      <section className="carrier-use-cases">
        {carrier.bestFor.map((item) => (
          <article key={item}>
            <span>Use case</span>
            <h3>{item}</h3>
            <p>Route this carrier’s normalized timeline into dashboards, customer tracking pages, signed webhooks, and support workflows.</p>
          </article>
        ))}
      </section>

      <section className="carrier-guide">
        <div>
          <p className="eyebrow">Tracking-number guidance</p>
          <h2>Recognize {carrier.name} shipments before customers pick a carrier.</h2>
          <p>
            Carrier detection is important because customers and support agents often paste a tracking number without
            selecting a carrier. For {carrier.name}, Trackified uses known tracking-number patterns, carrier hints, and
            account context to rank candidates and reduce manual selection.
          </p>
        </div>
        <div className="format-stack">
          {carrier.formats.map((format) => <span key={format}>{format}</span>)}
        </div>
      </section>

      <section className="implementation-band carrier-api-band">
        <div>
          <p className="eyebrow">API shape</p>
          <h2>Carrier details stay readable inside the same shipment object.</h2>
          <p>Applications should not need carrier-specific UI logic just to explain where a package is or what happened next.</p>
        </div>
        <pre>{`{
  "carrier": "${carrier.id}",
  "carrier_name": "${carrier.name}",
  "status": "in_transit",
  "service_level": "${carrier.services[0]}",
  "events": [
    {
      "status": "${carrier.eventCoverage[0].toLowerCase().replaceAll(" ", "_")}",
      "location": "${carrier.region}",
      "description": "${carrier.eventCoverage[0]}"
    }
  ]
}`}</pre>
      </section>

      <section className="carrier-roadmap">
        <article><span>01</span><h3>Detect</h3><p>Identify candidate carriers from tracking-number formats, account context, and customer-provided metadata.</p></article>
        <article><span>02</span><h3>Normalize</h3><p>Convert carrier milestones into consistent Trackified statuses, descriptions, timestamps, and locations.</p></article>
        <article><span>03</span><h3>Distribute</h3><p>Publish updates to dashboards, white-label pages, webhooks, API reads, and agent workflows.</p></article>
      </section>

      <section className="carrier-playbook">
        <div>
          <p className="eyebrow">Operations playbook</p>
          <h2>Recommended {carrier.name} monitoring workflow</h2>
          <p>
            Start by registering the tracking number as soon as the order is fulfilled or imported from an upstream
            system. If the package is not yet scanned, keep customer messaging conservative. Once the first carrier
            milestone appears, expose the timeline in the dashboard and branded tracking page, then let webhooks drive
            downstream notifications and support automation.
          </p>
          <p>
            For {carrier.name}, high-touch support teams can request a priority refresh for individual shipments, while
            bulk order flows should rely on scheduled monitoring, webhook delivery, and status-change automation.
          </p>
        </div>
        <ol>
          <li><strong>Register early</strong><span>Create the tracking record before customers ask for delivery status.</span></li>
          <li><strong>Wait for signal</strong><span>Use pending language until {carrier.name} emits the first meaningful milestone.</span></li>
          <li><strong>Notify on change</strong><span>Trigger customer messaging only when status or delivery confidence changes.</span></li>
          <li><strong>Escalate exceptions</strong><span>Route failed delivery, customs, return, or delay events into support workflows.</span></li>
        </ol>
      </section>

      <section className="carrier-faq">
        <article>
          <h3>Does Trackified support {carrier.name} tracking?</h3>
          <p>
            Yes. {carrier.name} is listed as live coverage with API, dashboard, branded page, and webhook workflows.
          </p>
        </article>
        <article>
          <h3>What {carrier.name} events are normalized?</h3>
          <p>
            Trackified models events including {carrier.eventCoverage.join(", ").toLowerCase()}. These events map into
            standard timeline and status fields for product and support workflows.
          </p>
        </article>
        <article>
          <h3>Can {carrier.name} updates trigger webhooks?</h3>
          <p>
            Yes. Shipment updates can trigger signed webhook events such as tracking.updated, tracking.status_changed,
            tracking.delivered, and tracking.exception.
          </p>
        </article>
        <article>
          <h3>What is the best use case for {carrier.name}?</h3>
          <p>
            {carrier.name} is best suited for {carrier.bestFor.join(", ").toLowerCase()}, especially when teams need
            one timeline across API responses, customer pages, and support tools.
          </p>
        </article>
      </section>

      <section className="related-carriers">
        <div>
          <p className="eyebrow">Related coverage</p>
          <h2>Other carriers often evaluated with {carrier.name}</h2>
        </div>
        <div>
          {relatedCarriers.map((item) => (
            <a href={`/carriers/${item.id}`} key={item.id}>
              <span>{item.tier}</span>
              <strong>{item.name}</strong>
              <p>{item.summary}</p>
            </a>
          ))}
        </div>
      </section>
    </MarketingChrome>
  );
}
