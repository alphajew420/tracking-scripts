import { AppShell } from "../../../components/app-shell";
import { DashboardTeam } from "../../../components/dashboard-team";

export default function TeamPage() {
  return (
    <AppShell active="/dashboard/team">
      <div className="topbar">
        <div><p className="eyebrow">Team</p><h1>Invite operators and manage workspace access.</h1></div>
      </div>
      <section className="grid">
        <DashboardTeam />
      </section>
    </AppShell>
  );
}
