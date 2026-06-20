import Link from "next/link";
import { AppShell } from "../../components/app-shell";
import { DashboardOverview } from "../../components/dashboard-overview";
import { DashboardTrackings } from "../../components/dashboard-trackings";

export default function DashboardPage() {
  return (
    <AppShell active="/dashboard">
      <div className="topbar">
        <div>
          <p className="eyebrow">Operations console</p>
          <h1>Every shipment, carrier, and exception in one queue.</h1>
        </div>
      </div>

      <section className="grid" aria-label="Tracking summary">
        <DashboardOverview />

        <DashboardTrackings />

        <div className="panel pad span-4">
          <p className="eyebrow">Next setup step</p>
          <h2>Connect your first workflow.</h2>
          <p>Start with an API key, register a tracking number, then add a webhook endpoint before routing customer-facing pages.</p>
          <div className="actions">
            <Link className="button primary" href="/dashboard/keys">Create key</Link>
            <Link className="button" href="/dashboard/webhooks">Add webhook</Link>
          </div>
        </div>

        <div className="panel pad span-12">
          <h2>Launch checklist</h2>
          <div className="setup-list">
            <div><strong>1. Create an API key</strong><span>Generate a test or live key for your first integration.</span></div>
            <div><strong>2. Register a tracking</strong><span>POST to /v1/trackings or use the bulk endpoint.</span></div>
            <div><strong>3. Add a webhook</strong><span>Receive signed shipment updates as statuses change.</span></div>
            <div><strong>4. Configure branding</strong><span>Set up customer-facing tracking pages before launch.</span></div>
          </div>
        </div>
      </section>
    </AppShell>
  );
}
