import { MarketingChrome } from "@/components/marketing-shell";

const changes = [
  ["2026-06-07", "Unified tracking architecture", "Standardized shipment registration, carrier coverage, monitoring, and event delivery surfaces."],
  ["2026-06-07", "REST API skeleton", "Added tracking, carrier, webhook, account, and OpenAPI surfaces."],
  ["2026-06-07", "Marketing site", "Added product, solution, carrier, developer, pricing, and comparison pages."],
];

export default function Page() {
  return (
    <MarketingChrome>
      <section className="subpage-hero">
        <p className="eyebrow">Changelog</p>
        <h1>Build log for customers evaluating momentum.</h1>
        <p>Public changelogs are trust infrastructure. They show carrier additions, API changes, dashboard improvements, and incidents.</p>
      </section>
      <section className="timeline-list">
        {changes.map(([date, title, copy]) => (
          <article key={title}>
            <time>{date}</time>
            <h3>{title}</h3>
            <p>{copy}</p>
          </article>
        ))}
      </section>
      <section className="cta-panel">
        <div>
          <p className="eyebrow">Release policy</p>
          <h2>Every carrier addition, API field, webhook event, and dashboard surface should land here.</h2>
        </div>
      </section>
    </MarketingChrome>
  );
}
