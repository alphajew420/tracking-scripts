import Link from "next/link";
import { PackageSearch } from "lucide-react";
import { ForgotPasswordForm } from "../../components/auth-forms";

export default function ForgotPasswordPage() {
  return (
    <main className="auth-page">
      <section className="panel auth-card">
        <div className="brand"><span className="mark"><PackageSearch size={18} /></span> Trackified</div>
        <p className="eyebrow" style={{ marginTop: 28 }}>Password reset</p>
        <h1 style={{ fontSize: 42 }}>Send a reset link.</h1>
        <ForgotPasswordForm />
        <p>Remembered it? <Link href="/login">Sign in</Link></p>
      </section>
    </main>
  );
}
