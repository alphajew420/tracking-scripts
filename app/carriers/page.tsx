import Link from "next/link";
import { CarrierSearch } from "@/components/carrier-search";
import { MarketingChrome } from "@/components/marketing-shell";
import { carriers } from "@/lib/marketing";

export default function Page() {
  const live = carriers.filter((carrier) => carrier.status === "Live coverage");

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
