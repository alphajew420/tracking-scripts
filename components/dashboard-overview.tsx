"use client";

import { useEffect, useState } from "react";
import { dashboardFetch } from "@/lib/dashboard-api";

type Usage = {
  trackings_used: number;
  trackings_limit: number;
  webhook_deliveries: number;
};

type TrackingRow = {
  status: string;
};

type WebhookRow = {
  id: string;
};

export function DashboardOverview() {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [trackings, setTrackings] = useState<TrackingRow[]>([]);
  const [webhooks, setWebhooks] = useState<WebhookRow[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([
      dashboardFetch("/v1/account/usage"),
      dashboardFetch("/v1/trackings?limit=100"),
      dashboardFetch("/v1/webhooks?limit=100"),
    ])
      .then(([usageResult, trackingResult, webhookResult]) => {
        setUsage(usageResult);
        setTrackings(trackingResult.data ?? []);
        setWebhooks(webhookResult.data ?? []);
      })
      .catch((err) => setError((err as Error).message));
  }, []);

  const active = trackings.filter((tracking) => !["delivered", "exception"].includes(tracking.status)).length;
  const delivered = trackings.filter((tracking) => tracking.status === "delivered").length;

  if (error) {
    return <div className="panel pad span-12"><p className="form-error">{error}</p></div>;
  }

  return (
    <>
      <div className="panel pad metric span-3">
        <p className="eyebrow">Active</p>
        <strong>{usage ? active : "..."}</strong>
        <p>{usage ? `${usage.trackings_used} registered this month.` : "Loading account data."}</p>
      </div>
      <div className="panel pad metric span-3">
        <p className="eyebrow">Delivered</p>
        <strong>{usage ? delivered : "..."}</strong>
        <p>Completed shipments in the current account view.</p>
      </div>
      <div className="panel pad metric span-3">
        <p className="eyebrow">Webhooks</p>
        <strong>{usage ? webhooks.length : "..."}</strong>
        <p>{usage ? `${usage.webhook_deliveries} delivery records this month.` : "Loading webhook activity."}</p>
      </div>
      <div className="panel pad metric span-3">
        <p className="eyebrow">Plan usage</p>
        <strong>{usage ? `${usage.trackings_used}/${usage.trackings_limit}` : "..."}</strong>
        <p>Monthly tracking registrations.</p>
      </div>
    </>
  );
}
