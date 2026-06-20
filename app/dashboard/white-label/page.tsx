import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { AppShell } from "../../../components/app-shell";
import { DashboardWhiteLabel } from "../../../components/dashboard-white-label";

const publicWebBase = process.env.PUBLIC_WEB_BASE_URL ?? "https://trackified.15-204-158-166.sslip.io";

export default function WhiteLabelPage() {
  return (
    <AppShell active="/dashboard/white-label">
      <div className="topbar">
        <div><p className="eyebrow">Customer experience</p><h1>Branded tracking pages for every account.</h1></div>
        <Link href="/t/preview" className="button primary"><ExternalLink size={16} /> Preview empty page</Link>
      </div>
      <section className="split">
        <DashboardWhiteLabel />
        <div className="panel pad">
          <h2>Embed</h2>
          <p>Use the public link, iframe, or JS widget. Public pages hide PII by default unless the account opts in.</p>
          <pre style={{ overflow: "auto", background: "var(--ink)", color: "white", padding: 14, borderRadius: 7 }}>{`<script src="${publicWebBase}/widget.js"
  data-tracking-id="trk_..."
  data-theme="default"></script>`}</pre>
        </div>
      </section>
    </AppShell>
  );
}
