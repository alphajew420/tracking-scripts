import { BellRing } from "lucide-react";
import { AppShell } from "../../../components/app-shell";

export default function AlertsPage() {
  return (
    <AppShell active="/dashboard/alerts">
      <div className="topbar"><div><p className="eyebrow">Carrier health</p><h1>Alert when carrier update success drops below your SLA.</h1></div></div>
      <section className="grid">
        <div className="panel pad span-12 empty-state">
          <BellRing size={22} />
          <p className="eyebrow">No alerts configured</p>
          <h2>Create alert policies after live traffic starts.</h2>
          <p>Alert rules will cover carrier health, webhook delivery failures, queue latency, usage thresholds, and account-specific incidents.</p>
        </div>
      </section>
    </AppShell>
  );
}
