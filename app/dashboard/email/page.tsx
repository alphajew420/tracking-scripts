import { AppShell } from "../../../components/app-shell";
import { DashboardEmail } from "../../../components/dashboard-email";

export default function EmailPage() {
  return (
    <AppShell active="/dashboard/email">
      <div className="topbar">
        <div><p className="eyebrow">Email</p><h1>Verification, reset, and invite delivery history.</h1></div>
      </div>
      <section className="grid">
        <DashboardEmail />
      </section>
    </AppShell>
  );
}
