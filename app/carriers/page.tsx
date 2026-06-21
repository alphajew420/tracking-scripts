import Link from "next/link";
import { CarrierSearch } from "@/components/carrier-search";
import { MarketingChrome } from "@/components/marketing-shell";
import { listCarrierValidationSummary } from "@/lib/carrier-validation";
import { carriers } from "@/lib/marketing";

export default function Page() {
  const live = carriers.filter((carrier) => carrier.status === "Live coverage");
  const validation = listCarrierValidationSummary();
  const priorityQueue = validation.values.filter((item) => item.status !== "verified").slice(0, 8);

  return (
    <MarketingChrome>
      <section className="carrier-hero">
        <div>
          <p className="eyebrow">Carrier network</p>
          <h1>Coverage customers can trust, not a logo wall.</h1>
          <p>
            Trackified organizes each carrier by region, service class, tracking formats, supported event milestones,
            monitoring coverage, and customer-facing event depth so operators know exactly what coverage means.
          </p>
        </div>
        <aside>
          <span>Live coverage</span>
          <strong>{live.length}</strong>
          <p>active carrier integrations available across API, dashboard, branded pages, and webhook workflows.</p>
        </aside>
      </section>

      <section className="carrier-status-board">
        <article className="carrier-status-card">
          <span>Verified</span>
          <strong>{validation.counts.verified}</strong>
          <p>Real tracking numbers confirmed against live timelines.</p>
        </article>
        <article className="carrier-status-card">
          <span>Needs retest</span>
          <strong>{validation.counts.needs_retest}</strong>
          <p>Wired modules that need a fresh sample before we call them stable.</p>
        </article>
        <article className="carrier-status-card">
          <span>Needs real sample</span>
          <strong>{validation.counts.needs_real_sample}</strong>
          <p>Scaffolded carriers waiting on a live number from the field.</p>
        </article>
        <article className="carrier-status-card">
          <span>Unvalidated</span>
          <strong>{validation.counts.unvalidated}</strong>
          <p>Registered carriers with no validation ledger entry yet.</p>
        </article>
      </section>

      <section className="carrier-work-queue">
        <div>
          <p className="eyebrow">Carrier work queue</p>
          <h2>Fix the hardest carriers first, not the easiest catalog entries.</h2>
          <p>
            The next gain comes from moving carriers out of retest and scaffolded states. These are the carriers that
            still need a fresh sample, a retry, or a real-world number from a customer flow.
          </p>
        </div>
        <div className="carrier-work-list">
          {priorityQueue.map((item) => (
            <article key={item.carrier} className={`carrier-work-item ${item.status}`}>
              <strong>{item.carrier}</strong>
              <span>{item.status.replaceAll("_", " ")}</span>
              <p>{item.result}</p>
              {item.sample ? <small>Sample: {item.sample}</small> : <small>Waiting on a real sample</small>}
            </article>
          ))}
        </div>
      </section>

      <section className="registry-summary">
        <article><strong>{live.length}</strong><span>live core carriers</span></article>
        <article><strong>Global</strong><span>major parcel networks</span></article>
        <article><strong>API</strong><span>normalized tracking model</span></article>
        <article><strong>Push</strong><span>signed webhook events</span></article>
      </section>

      <section className="carrier-spotlight">
        {live.map((carrier) => (
          <Link href={`/carriers/${carrier.id}`} key={carrier.id}>
            <div>
              <span>{carrier.tier}</span>
              <strong>{carrier.name}</strong>
              <p>{carrier.summary}</p>
            </div>
            <ul>
              <li>{carrier.region}</li>
              <li>{carrier.services.slice(0, 2).join(" / ")}</li>
              <li>{carrier.updateCadence}</li>
            </ul>
          </Link>
        ))}
      </section>

      <section className="carrier-section-head">
        <div>
          <p className="eyebrow">Carrier explorer</p>
          <h2>Only active carrier coverage is shown publicly.</h2>
        </div>
        <p>Planned or internal rollout entries are not listed here. The public catalog should only show carriers customers can actually use.</p>
      </section>

      <CarrierSearch carriers={live} />

      <section className="implementation-band">
        <div>
          <p className="eyebrow">Registry strategy</p>
          <h2>A carrier registry built for scale, governance, and customer trust.</h2>
          <p>Each public carrier entry tracks region, service class, status mapping, tracking-number patterns, reliability notes, and customer-facing event depth.</p>
        </div>
        <pre>{`id: ups
region: Global
service_class: parcel
coverage_status: live
tracking_patterns: ["1Z...", "package references"]
events: delivered, in_transit, exception`}</pre>
      </section>
    </MarketingChrome>
  );
}
