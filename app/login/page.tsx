import Link from "next/link";
import { PackageSearch } from "lucide-react";
import { Suspense } from "react";
import { LoginForm } from "../../components/auth-forms";

export default function LoginPage() {
  return (
    <main className="auth-page">
      <section className="panel auth-card">
        <div className="brand"><span className="mark"><PackageSearch size={18} /></span> Trackified</div>
        <p className="eyebrow" style={{ marginTop: 28 }}>Sign in</p>
        <h1 style={{ fontSize: 42 }}>Enter the operations console.</h1>
        <Suspense fallback={<p>Loading sign in...</p>}><LoginForm /></Suspense>
        <p><Link href="/forgot-password">Forgot password?</Link></p>
        <p>No account yet? <Link href="/signup">Create a workspace</Link></p>
      </section>
    </main>
  );
}
