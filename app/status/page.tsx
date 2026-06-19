import { MarketingChrome } from "@/components/marketing-shell";

const services = [["API", "Operational"], ["Dashboard", "Operational"], ["Event scheduler", "Operational"], ["Processing pipeline", "Operational"], ["Webhook delivery", "Operational"], ["Carrier network", "Degraded carriers visible here"]];

export default function Page() {
  return (
    <MarketingChrome>
      <section className="subpage-hero">
        <p className="eyebrow">Status</p>
        <h1>Carrier and platform health should be public.</h1>
        <p>This page is the marketing shell for live status checks, carrier success rates, and webhook delivery health.</p>
      </section>
      <section className="status-board">
        {services.map(([name, status]) => (
          <article key={name}>
            <strong>{name}</strong>
            <span>{status}</span>
          </article>
        ))}
      </section>
      <section className="ops-command status-deep">
        <div className="ops-copy">
          <p className="eyebrow">Carrier health</p>
          <h2>Status should include carrier-specific failure rates, not just API uptime.</h2>
          <p>A real tracking provider can be globally up while USPS or FedEx is degraded. This page is structured to show both platform services and carrier health.</p>
        </div>
        <div className="proof-bar">
          <div><strong>95%</strong><span>alert threshold</span></div>
          <div><strong>24h</strong><span>rolling carrier window</span></div>
          <div><strong>5</strong><span>webhook retry attempts</span></div>
          <div><strong>100</strong><span>auto-disable failures</span></div>
        </div>
      </section>
    </MarketingChrome>
  );
}
