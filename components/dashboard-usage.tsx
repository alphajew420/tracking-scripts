"use client";

import { Activity, Gauge } from "lucide-react";
import { useEffect, useState } from "react";
import { dashboardFetch } from "@/lib/dashboard-api";

type Usage = {
  period_start: string;
  period_end: string;
  trackings_used: number;
  trackings_limit: number;
  rate_limit_per_minute: number;
  webhook_deliveries: number;
  carrier_volume: { carrier: string; count: number }[];
};

export function DashboardUsage() {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    dashboardFetch("/v1/account/usage")
      .then(setUsage)
      .catch((err) => setError(err.message));
  }, []);

  if (error) {
    return <div className="panel pad span-12"><p className="form-error">{error}</p></div>;
  }

  const used = usage?.trackings_used ?? 0;
  const limit = usage?.trackings_limit ?? 0;
  const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;

  return (
    <>
      <div className="panel pad span-3"><p className="eyebrow">Plan usage</p><strong style={{ fontSize: 34 }}>{used} / {limit || "—"}</strong><p>{percent}% of monthly included volume.</p></div>
      <div className="panel pad span-3"><p className="eyebrow">Rate limit</p><strong style={{ fontSize: 34 }}>{usage?.rate_limit_per_minute ?? "—"}/min</strong><p>Applied per account API key.</p></div>
      <div className="panel pad span-3"><p className="eyebrow">Webhooks</p><strong style={{ fontSize: 34 }}>{usage?.webhook_deliveries ?? "—"}</strong><p>Delivery records this month.</p></div>
      <div className="panel pad span-3"><p className="eyebrow">Carrier updates</p><strong style={{ fontSize: 34 }}>{usage?.carrier_volume.reduce((sum, row) => sum + row.count, 0) ?? "—"}</strong><p>Registered tracking volume.</p></div>
      <div className="panel pad span-8">
        <h2><Activity size={20} /> Current usage window</h2>
        {usage ? (
          <div className="empty-state compact">
            <p>{new Date(usage.period_start).toLocaleDateString()} through {new Date(usage.period_end).toLocaleDateString()}</p>
            <div className="meter"><span style={{ width: `${percent}%` }} /></div>
          </div>
        ) : <div className="empty-state compact"><p>Loading account usage...</p></div>}
      </div>
      <div className="panel pad span-4">
        <h2><Gauge size={20} /> Carrier volume</h2>
        {usage?.carrier_volume.length ? (
          <div className="stack-list">
            {usage.carrier_volume.map((row) => <div key={row.carrier}><strong>{row.carrier}</strong><span>{row.count}</span></div>)}
          </div>
        ) : <div className="empty-state compact"><p>Carrier breakdown appears after trackings are registered.</p></div>}
      </div>
    </>
  );
}
