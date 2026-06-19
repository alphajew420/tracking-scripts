import { Suspense } from "react";
import { PackageSearch } from "lucide-react";
import { ResetPasswordForm } from "../../components/auth-forms";

export default function ResetPasswordPage() {
  return (
    <main className="auth-page">
      <section className="panel auth-card">
        <div className="brand"><span className="mark"><PackageSearch size={18} /></span> Trackified</div>
        <p className="eyebrow" style={{ marginTop: 28 }}>Reset password</p>
        <h1 style={{ fontSize: 42 }}>Choose a new password.</h1>
        <Suspense fallback={<p>Loading reset form...</p>}><ResetPasswordForm /></Suspense>
      </section>
    </main>
  );
}
