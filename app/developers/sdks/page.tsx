import { MarketingChrome } from "@/components/marketing-shell";

export default function Page() {
  return (
    <MarketingChrome>
      <section className="subpage-hero">
        <p className="eyebrow">SDKs</p>
        <h1>TypeScript first, generated clients next.</h1>
        <p>@tracking/sdk will wrap OpenAPI-generated types with retries, webhook verification helpers, and bulk row error handling.</p>
      </section>
      <section className="subpage-grid">
        <article className="subpage-panel"><h2>TypeScript</h2><p>Typed resources, pagination helpers, and webhook verification.</p></article>
        <article className="subpage-panel"><h2>Future clients</h2><p>Python, PHP, Ruby, and Go should be generated from the same OpenAPI source.</p></article>
      </section>
    </MarketingChrome>
  );
}
