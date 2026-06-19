import { MarketingChrome } from "@/components/marketing-shell";

export default function Page() {
  return (
    <MarketingChrome>
      <section className="subpage-hero">
        <p className="eyebrow">MCP server</p>
        <h1>Package tracking tools for AI agents.</h1>
        <p>Expose track_package, list_trackings, carrier_detect, and subscribe-style hooks to Claude/GPT workflows.</p>
      </section>
      <section className="subpage-grid">
        <article className="subpage-panel dark"><h2>Agent-safe scope</h2><p>Keys remain account-scoped and tool outputs use the same normalized tracking model as the API.</p></article>
        <article className="subpage-panel"><h2>Use cases</h2><p>Customer support agents, delivery exception monitors, procurement ops, and reseller dashboards.</p></article>
      </section>
    </MarketingChrome>
  );
}
