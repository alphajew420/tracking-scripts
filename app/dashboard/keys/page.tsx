import { Plus } from "lucide-react";
import { DashboardApiKeys } from "../../../components/dashboard-api-keys";
import { AppShell } from "../../../components/app-shell";

export default function ApiKeysPage() {
  return (
    <AppShell active="/dashboard/keys">
      <div className="topbar">
        <div><p className="eyebrow">Access control</p><h1>API keys scoped for stores, support teams, and agents.</h1></div>
        <a className="button primary" href="#create-key"><Plus size={16} /> Generate key</a>
      </div>
      <section className="grid">
        <div id="create-key" style={{ display: "contents" }}><DashboardApiKeys /></div>
      </section>
    </AppShell>
  );
}
