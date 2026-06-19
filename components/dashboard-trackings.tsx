"use client";

import { Download, Plus } from "lucide-react";
import { useEffect, useState, useTransition } from "react";
import { dashboardFetch } from "@/lib/dashboard-api";
import { StatusPill, type TrackingStatus } from "./status-pill";

type TrackingRow = {
  id: string;
  tracking_number: string;
  carrier: string;
  status: TrackingStatus;
  events: unknown[];
  created_at: string;
  updated_at: string;
};

export function DashboardTrackings() {
  const [trackings, setTrackings] = useState<TrackingRow[]>([]);
  const [filter, setFilter] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [isPending, startTransition] = useTransition();

  async function loadTrackings() {
    const result = await dashboardFetch("/v1/trackings?limit=50");
    setTrackings(result.data ?? []);
  }

  useEffect(() => {
    loadTrackings().catch((err) => setError(err.message));
  }, []);

  async function registerTracking(formData: FormData) {
    setError("");
    setMessage("");
    const trackingNumber = String(formData.get("tracking_number") ?? "").trim();
    const carrier = String(formData.get("carrier") ?? "").trim();
    if (!trackingNumber) {
      setError("Tracking number is required.");
      return;
    }
    startTransition(async () => {
      try {
        await dashboardFetch("/v1/trackings", {
          method: "POST",
          body: JSON.stringify({
            tracking_number: trackingNumber,
            carrier: carrier || undefined,
          }),
        });
        setMessage("Tracking registered.");
        await loadTrackings();
      } catch (err) {
        setError((err as Error).message);
      }
    });
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify(trackings, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "trackified-trackings.json";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const visible = trackings.filter((tracking) => {
    const needle = filter.toLowerCase();
    return [tracking.tracking_number, tracking.carrier, tracking.status, tracking.id].join(" ").toLowerCase().includes(needle);
  });

  return (
    <>
      <div className="panel pad span-12 tracking-toolbar">
        <div>
          <p className="eyebrow">Tracking controls</p>
          <h2>Register, filter, and export real tracking records.</h2>
        </div>
        <div className="actions">
        <label className="dashboard-search">
          <span className="sr-only">Filter trackings</span>
          <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter trackings..." />
        </label>
        <button className="button" onClick={exportJson} disabled={!trackings.length}><Download size={16} /> Export JSON</button>
        </div>
      </div>

      <form action={registerTracking} className="panel pad span-4">
        <h2>Register tracking</h2>
        <label className="field">Tracking number<input name="tracking_number" placeholder="TRACKING_NUMBER" /></label>
        <label className="field">Carrier optional<input name="carrier" placeholder="ups, usps, fedex..." /></label>
        <button className="button primary" disabled={isPending} type="submit"><Plus size={16} /> {isPending ? "Registering..." : "Register"}</button>
        {message ? <p className="form-success">{message}</p> : null}
        {error ? <p className="form-error">{error}</p> : null}
      </form>

      <div className="panel span-8">
        {visible.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Tracking</th><th>Carrier</th><th>Status</th><th>Events</th><th>Updated</th></tr>
              </thead>
              <tbody>
                {visible.map((tracking) => (
                  <tr key={tracking.id}>
                    <td><strong>{tracking.tracking_number}</strong><br /><span>{tracking.id}</span></td>
                    <td>{tracking.carrier}</td>
                    <td><StatusPill status={tracking.status} /></td>
                    <td>{tracking.events?.length ?? 0}</td>
                    <td>{new Date(tracking.updated_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">
            <p className="eyebrow">No trackings yet</p>
            <h2>Register your first tracking number to populate this queue.</h2>
            <p>The dashboard will show real shipment state, event timelines, carrier health, and webhook delivery once data exists.</p>
          </div>
        )}
      </div>
    </>
  );
}
