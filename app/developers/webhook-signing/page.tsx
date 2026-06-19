import { MarketingChrome } from "@/components/marketing-shell";

export default function Page() {
  return (
    <MarketingChrome>
      <section className="subpage-hero">
        <p className="eyebrow">Webhook signing</p>
        <h1>Verify every push before it hits your workflow.</h1>
        <p>Webhook deliveries include X-Tracking-Signature with timestamp and v1 HMAC digest. Reject old timestamps to prevent replay.</p>
      </section>
      <section className="api-panel standalone">
        <div className="panel-top"><span>signature header</span><span>sha256</span></div>
        <pre>{`X-Tracking-Signature: t=1780855200,v1=<hex-hmac>

signed_payload = timestamp + "." + raw_body
hmac = HMAC_SHA256(webhook_secret, signed_payload)`}</pre>
      </section>
    </MarketingChrome>
  );
}
