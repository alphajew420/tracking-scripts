import { Suspense } from "react";
import { PackageSearch } from "lucide-react";
import { AcceptInviteForm } from "../../components/auth-forms";

export default function AcceptInvitePage() {
  return (
    <main className="auth-page">
      <section className="panel auth-card">
        <div className="brand"><span className="mark"><PackageSearch size={18} /></span> Trackified</div>
        <p className="eyebrow" style={{ marginTop: 28 }}>Team invite</p>
        <h1 style={{ fontSize: 42 }}>Join the workspace.</h1>
        <Suspense fallback={<p>Loading invite...</p>}><AcceptInviteForm /></Suspense>
      </section>
    </main>
  );
}
