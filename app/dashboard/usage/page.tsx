import { AppShell } from "../../../components/app-shell";
import { DashboardUsage } from "../../../components/dashboard-usage";

export default function UsagePage() {
  return (
    <AppShell active="/dashboard/usage">
      <div className="topbar">
        <div><p className="eyebrow">Metering</p><h1>Quota, rate limits, and carrier update volume.</h1></div>
      </div>
      <section className="grid">
        <DashboardUsage />
      </section>
    </AppShell>
  );
}
