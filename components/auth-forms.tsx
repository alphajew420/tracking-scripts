"use client";

import { ArrowRight } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import { dashboardFetch } from "@/lib/dashboard-api";

export function LoginForm() {
  const router = useRouter();
  const search = useSearchParams();
  const [error, setError] = useState("");
  const [isPending, startTransition] = useTransition();

  function submit(formData: FormData) {
    setError("");
    startTransition(async () => {
      try {
        await dashboardFetch("/v1/auth/login", {
          method: "POST",
          body: JSON.stringify({
            email: String(formData.get("email") ?? ""),
            password: String(formData.get("password") ?? ""),
          }),
        });
        router.replace(search.get("next") || "/dashboard");
      } catch (err) {
        setError((err as Error).message);
      }
    });
  }

  return (
    <form action={submit} style={{ display: "grid", gap: 14, marginTop: 24 }}>
      <label className="field">Email<input name="email" type="email" autoComplete="email" placeholder="ops@example.com" required /></label>
      <label className="field">Password<input name="password" type="password" autoComplete="current-password" placeholder="Minimum 8 characters" required /></label>
      <button className="button primary" type="submit" disabled={isPending}><ArrowRight size={16} /> {isPending ? "Signing in..." : "Continue"}</button>
      {error ? <p className="form-error">{error}</p> : null}
    </form>
  );
}

export function SignupForm() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [isPending, startTransition] = useTransition();

  function submit(formData: FormData) {
    setError("");
    startTransition(async () => {
      try {
        await dashboardFetch("/v1/auth/signup", {
          method: "POST",
          body: JSON.stringify({
            company: String(formData.get("company") ?? ""),
            name: String(formData.get("name") ?? ""),
            email: String(formData.get("email") ?? ""),
            password: String(formData.get("password") ?? ""),
          }),
        });
        router.replace("/dashboard");
      } catch (err) {
        setError((err as Error).message);
      }
    });
  }

  return (
    <form action={submit} style={{ display: "grid", gap: 14, marginTop: 24 }}>
      <label className="field">Company<input name="company" autoComplete="organization" placeholder="Your company" required /></label>
      <label className="field">Name<input name="name" autoComplete="name" placeholder="Operations lead" /></label>
      <label className="field">Email<input name="email" type="email" autoComplete="email" placeholder="ops@example.com" required /></label>
      <label className="field">Password<input name="password" type="password" autoComplete="new-password" placeholder="Minimum 8 characters" required /></label>
      <button className="button primary" type="submit" disabled={isPending}><ArrowRight size={16} /> {isPending ? "Creating..." : "Create account"}</button>
      {error ? <p className="form-error">{error}</p> : null}
    </form>
  );
}

export function ForgotPasswordForm() {
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [isPending, startTransition] = useTransition();

  function submit(formData: FormData) {
    setMessage("");
    setError("");
    startTransition(async () => {
      try {
        const result = await dashboardFetch("/v1/auth/password-reset/request", {
          method: "POST",
          body: JSON.stringify({ email: String(formData.get("email") ?? "") }),
        });
        setMessage(result.token ? `Reset email queued. Dev token: ${result.token}` : "If the email exists, a reset link has been sent.");
      } catch (err) {
        setError((err as Error).message);
      }
    });
  }

  return (
    <form action={submit} style={{ display: "grid", gap: 14, marginTop: 24 }}>
      <label className="field">Email<input name="email" type="email" autoComplete="email" placeholder="ops@example.com" required /></label>
      <button className="button primary" type="submit" disabled={isPending}><ArrowRight size={16} /> {isPending ? "Sending..." : "Send reset link"}</button>
      {message ? <p className="form-success">{message}</p> : null}
      {error ? <p className="form-error">{error}</p> : null}
    </form>
  );
}

export function ResetPasswordForm() {
  const router = useRouter();
  const search = useSearchParams();
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [isPending, startTransition] = useTransition();

  function submit(formData: FormData) {
    setMessage("");
    setError("");
    startTransition(async () => {
      try {
        await dashboardFetch("/v1/auth/password-reset/confirm", {
          method: "POST",
          body: JSON.stringify({
            token: String(formData.get("token") ?? search.get("token") ?? ""),
            password: String(formData.get("password") ?? ""),
          }),
        });
        setMessage("Password reset. Redirecting to sign in...");
        setTimeout(() => router.replace("/login"), 800);
      } catch (err) {
        setError((err as Error).message);
      }
    });
  }

  return (
    <form action={submit} style={{ display: "grid", gap: 14, marginTop: 24 }}>
      <label className="field">Reset token<input name="token" defaultValue={search.get("token") ?? ""} required /></label>
      <label className="field">New password<input name="password" type="password" autoComplete="new-password" placeholder="Minimum 8 characters" required /></label>
      <button className="button primary" type="submit" disabled={isPending}><ArrowRight size={16} /> {isPending ? "Resetting..." : "Reset password"}</button>
      {message ? <p className="form-success">{message}</p> : null}
      {error ? <p className="form-error">{error}</p> : null}
    </form>
  );
}

export function VerifyEmailForm() {
  const router = useRouter();
  const search = useSearchParams();
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [isPending, startTransition] = useTransition();

  function submit(formData: FormData) {
    setMessage("");
    setError("");
    startTransition(async () => {
      try {
        await dashboardFetch("/v1/auth/email-verification/confirm", {
          method: "POST",
          body: JSON.stringify({ token: String(formData.get("token") ?? search.get("token") ?? "") }),
        });
        setMessage("Email verified. Redirecting...");
        setTimeout(() => router.replace("/dashboard"), 800);
      } catch (err) {
        setError((err as Error).message);
      }
    });
  }

  return (
    <form action={submit} style={{ display: "grid", gap: 14, marginTop: 24 }}>
      <label className="field">Verification token<input name="token" defaultValue={search.get("token") ?? ""} required /></label>
      <button className="button primary" type="submit" disabled={isPending}><ArrowRight size={16} /> {isPending ? "Verifying..." : "Verify email"}</button>
      {message ? <p className="form-success">{message}</p> : null}
      {error ? <p className="form-error">{error}</p> : null}
    </form>
  );
}

export function AcceptInviteForm() {
  const router = useRouter();
  const search = useSearchParams();
  const [error, setError] = useState("");
  const [isPending, startTransition] = useTransition();

  function submit(formData: FormData) {
    setError("");
    startTransition(async () => {
      try {
        await dashboardFetch("/v1/account/team/invites/accept", {
          method: "POST",
          body: JSON.stringify({
            token: String(formData.get("token") ?? search.get("token") ?? ""),
            name: String(formData.get("name") ?? ""),
            password: String(formData.get("password") ?? ""),
          }),
        });
        router.replace("/dashboard");
      } catch (err) {
        setError((err as Error).message);
      }
    });
  }

  return (
    <form action={submit} style={{ display: "grid", gap: 14, marginTop: 24 }}>
      <label className="field">Invite token<input name="token" defaultValue={search.get("token") ?? ""} required /></label>
      <label className="field">Name<input name="name" autoComplete="name" placeholder="Your name" /></label>
      <label className="field">Password<input name="password" type="password" autoComplete="new-password" placeholder="Minimum 8 characters" required /></label>
      <button className="button primary" type="submit" disabled={isPending}><ArrowRight size={16} /> {isPending ? "Accepting..." : "Accept invite"}</button>
      {error ? <p className="form-error">{error}</p> : null}
    </form>
  );
}
