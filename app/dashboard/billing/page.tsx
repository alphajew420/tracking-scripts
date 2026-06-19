import { AppShell } from "../../../components/app-shell";
import { DashboardBilling } from "../../../components/dashboard-billing";

export default function BillingPage() {
  return (
    <AppShell active="/dashboard/billing">
      <div className="topbar">
        <div><p className="eyebrow">Billing</p><h1>Plans built around tracking volume and realtime delivery.</h1></div>
      </div>
      <section className="grid">
        <DashboardBilling />
      </section>
    </AppShell>
  );
}
