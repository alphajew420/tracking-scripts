import { Webhook } from "lucide-react";
import { DashboardWebhooks } from "../../../components/dashboard-webhooks";
import { AppShell } from "../../../components/app-shell";

export default function WebhooksPage() {
  return (
    <AppShell active="/dashboard/webhooks">
      <div className="topbar">
        <div><p className="eyebrow">Push delivery</p><h1>Signed webhook inbox with retry visibility.</h1></div>
        <a className="button primary" href="#add-endpoint"><Webhook size={16} /> Add endpoint</a>
      </div>
      <section className="grid">
        <div id="add-endpoint" style={{ display: "contents" }}><DashboardWebhooks /></div>
      </section>
    </AppShell>
  );
}
