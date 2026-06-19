import Link from "next/link";
import { MarketingChrome } from "@/components/marketing-shell";
import { pricingPlans } from "@/lib/marketing";

export default function Page() {
  return (
    <MarketingChrome>
      <section className="subpage-hero">
        <p className="eyebrow">Pricing</p>
        <h1>Simple infrastructure pricing for shipment visibility.</h1>
        <p>Start free, scale by monthly tracked shipments, and move into custom hosted or self-hosted lanes when volume demands it.</p>
      </section>
      <section className="pricing-grid">
        {pricingPlans.map(([name, price, trackings, bulk, rate, features]) => (
          <article key={name}>
            <p className="eyebrow">{name}</p>
            <h2>{price}</h2>
            <span>{trackings}</span>
            <ul className="check-list">
              <li>{bulk}</li>
              <li>{rate}</li>
              <li>{features}</li>
            </ul>
            <Link href="/signup" className="button primary">Choose {name}</Link>
          </article>
        ))}
      </section>
      <section className="pricing-detail">
        <article>
          <p className="eyebrow">Overage</p>
          <h2>$0.01 per tracking beyond plan</h2>
          <p>Usage resets monthly at the account timezone midnight on the first. Scale customers can move to committed-volume or self-hosted pricing.</p>
        </article>
        <article>
          <p className="eyebrow">Included</p>
          <ul className="check-list">
            <li>Hosted API and dashboard</li>
            <li>Signed webhooks and retry inbox</li>
            <li>Carrier detection endpoint</li>
            <li>Public tracking links</li>
            <li>Shipment monitoring and event delivery</li>
          </ul>
        </article>
      </section>
      <section className="faq-section">
        <article><h3>Do failed carrier updates count?</h3><p>Registered trackings count toward plan usage. Carrier issues are surfaced as health signals, not surprise line items.</p></article>
        <article><h3>Can we self-host?</h3><p>Scale customers can run the same infrastructure model with BYO Postgres, Redis, and background processing services.</p></article>
        <article><h3>Can we raise bulk limits?</h3><p>Yes. Scale raises bulk registration to 100 rows and increases API rate limits.</p></article>
      </section>
    </MarketingChrome>
  );
}
