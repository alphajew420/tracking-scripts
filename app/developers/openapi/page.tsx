import Link from "next/link";
import { MarketingChrome } from "@/components/marketing-shell";
import { apiBaseUrl } from "@/lib/site";

export default function Page() {
  return (
    <MarketingChrome>
      <section className="subpage-hero">
        <p className="eyebrow">OpenAPI</p>
        <h1>Import the live API contract into your tooling.</h1>
        <p>The running API exposes an OpenAPI document for Postman, Insomnia, codegen, and SDK generation.</p>
        <div className="actions">
          <Link href={`${apiBaseUrl()}/openapi.json`} className="button primary">Open openapi.json</Link>
          <Link href="/developers/api-reference" className="button">View endpoint map</Link>
        </div>
      </section>
      <section className="openapi-workbench">
        <article>
          <p className="eyebrow">Import</p>
          <h2>Use the spec in Postman, Insomnia, Speakeasy, Stainless, or OpenAPI Generator.</h2>
          <p>The OpenAPI document should be the contract for SDKs, docs, tests, and customer integration reviews.</p>
        </article>
        <article className="api-panel">
          <div className="panel-top"><span>openapi preview</span><span>3.1</span></div>
          <pre>{`{
  "openapi": "3.1.0",
  "paths": {
    "/v1/trackings": {
      "post": { "summary": "Register tracking" },
      "get": { "summary": "List trackings" }
    },
    "/v1/carriers/detect": {
      "get": { "summary": "Detect carrier candidates" }
    }
  }
}`}</pre>
        </article>
      </section>
      <section className="docs-reference-grid">
        <article><h3>Contract testing</h3><p>Validate API responses against the spec during CI so dashboard and SDK assumptions do not drift.</p></article>
        <article><h3>SDK generation</h3><p>Generate client types from OpenAPI, then layer ergonomic retries and webhook helpers on top.</p></article>
        <article><h3>Versioning</h3><p>Keep `/v1` stable. Add fields compatibly and move breaking changes to a future version namespace.</p></article>
      </section>
    </MarketingChrome>
  );
}
