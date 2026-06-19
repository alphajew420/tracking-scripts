import Link from "next/link";
import { PackageSearch } from "lucide-react";
import { SignupForm } from "../../components/auth-forms";

export default function SignupPage() {
  return (
    <main className="auth-page">
      <section className="panel auth-card">
        <div className="brand"><span className="mark"><PackageSearch size={18} /></span> Trackified</div>
        <p className="eyebrow" style={{ marginTop: 28 }}>Create workspace</p>
        <h1 style={{ fontSize: 42 }}>Start with shipment visibility infrastructure.</h1>
        <SignupForm />
        <p>Already have access? <Link href="/login">Sign in</Link></p>
      </section>
    </main>
  );
}
