import { Suspense } from "react";
import { PackageSearch } from "lucide-react";
import { VerifyEmailForm } from "../../components/auth-forms";

export default function VerifyEmailPage() {
  return (
    <main className="auth-page">
      <section className="panel auth-card">
        <div className="brand"><span className="mark"><PackageSearch size={18} /></span> Trackified</div>
        <p className="eyebrow" style={{ marginTop: 28 }}>Email verification</p>
        <h1 style={{ fontSize: 42 }}>Verify your workspace email.</h1>
        <Suspense fallback={<p>Loading verification...</p>}><VerifyEmailForm /></Suspense>
      </section>
    </main>
  );
}
