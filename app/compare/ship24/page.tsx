import { MarketingChrome } from "@/components/marketing-shell";
import { comparisons } from "@/lib/marketing";

export default function Page() {
  const comparison = comparisons.ship24;
  return (
    <MarketingChrome>
      <section className="subpage-hero"><p className="eyebrow">Compare</p><h1>Trackified vs {comparison.name}</h1><p>{comparison.thesis}</p></section>
      <section className="compare-table">{comparison.rows.map(([feature, them, us]) => <article key={feature}><strong>{feature}</strong><span>{comparison.name}: {them}</span><b>Trackified: {us}</b></article>)}</section>
    </MarketingChrome>
  );
}
