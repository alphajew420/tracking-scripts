"use client";

import { useEffect, useState, useTransition } from "react";
import { dashboardFetch } from "@/lib/dashboard-api";

type Settings = {
  domain: string | null;
  brand_name: string | null;
  accent_color: string;
  support_url: string | null;
  pii_public: boolean;
};

export function DashboardWhiteLabel() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    dashboardFetch("/v1/account/white-label")
      .then(setSettings)
      .catch((err) => setError(err.message));
  }, []);

  function save(formData: FormData) {
    setMessage("");
    setError("");
    startTransition(async () => {
      try {
        const updated = await dashboardFetch("/v1/account/white-label", {
          method: "PUT",
          body: JSON.stringify({
            domain: String(formData.get("domain") ?? ""),
            brand_name: String(formData.get("brand_name") ?? ""),
            accent_color: String(formData.get("accent_color") ?? "#08756f"),
            support_url: String(formData.get("support_url") ?? ""),
            pii_public: formData.get("pii_public") === "on",
          }),
        });
        setSettings(updated);
        setMessage("Brand settings saved.");
      } catch (err) {
        setError((err as Error).message);
      }
    });
  }

  return (
    <form action={save} className="panel pad">
      <h2>Brand settings</h2>
      <label className="field">Domain<input name="domain" defaultValue={settings?.domain ?? ""} placeholder="tracking.yourdomain.com" /></label>
      <label className="field">Brand name<input name="brand_name" defaultValue={settings?.brand_name ?? ""} placeholder="Your brand" /></label>
      <label className="field">Accent color<input name="accent_color" type="color" defaultValue={settings?.accent_color ?? "#08756f"} /></label>
      <label className="field">Support URL<input name="support_url" defaultValue={settings?.support_url ?? ""} placeholder="https://yourdomain.com/help" /></label>
      <label className="check-row"><input name="pii_public" type="checkbox" defaultChecked={settings?.pii_public ?? false} /> Show opted-in customer details on public tracking pages</label>
      <button className="button primary" type="submit" disabled={isPending}>{isPending ? "Saving..." : "Save settings"}</button>
      {message ? <p className="form-success">{message}</p> : null}
      {error ? <p className="form-error">{error}</p> : null}
    </form>
  );
}
