"use client";

import { useEffect, useState, useTransition } from "react";
import { dashboardFetch } from "@/lib/dashboard-api";

type Plan = {
  account_id: string;
  account_name: string;
  tier: string;
  monthly_price_usd: number;
  trackings_limit: number;
  rate_limit_per_minute: number;
  bulk_limit: number;
  realtime_ws: boolean;
  overage_usd_per_tracking: number;
};

const tiers = [
  ["Free", "$0", "100/mo", "5 bulk"],
  ["Starter", "$19", "1,000/mo", "40 bulk"],
  ["Pro", "$99", "10,000/mo", "40 bulk"],
  ["Scale", "Usage", "Unlimited", "100 bulk"],
];

export function DashboardBilling() {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    dashboardFetch("/v1/account/plan")
      .then(setPlan)
      .catch((err) => setError(err.message));
  }, []);

  function startCheckout(tier: string) {
    setError("");
    setMessage("");
    startTransition(async () => {
      try {
        const result = await dashboardFetch("/v1/account/billing/checkout", {
          method: "POST",
          body: JSON.stringify({ tier: tier.toLowerCase() }),
        });
        if (result.configured && result.url) window.location.href = result.url;
        else setMessage(result.error?.message ?? "Billing checkout is not configured yet.");
      } catch (err) {
        setError((err as Error).message);
      }
    });
  }

  function openPortal() {
    setError("");
    setMessage("");
    startTransition(async () => {
      try {
        const result = await dashboardFetch("/v1/account/billing/portal", { method: "POST", body: "{}" });
        if (result.configured && result.url) window.location.href = result.url;
        else setMessage(result.error?.message ?? "Billing portal is not configured yet.");
      } catch (err) {
        setError((err as Error).message);
      }
    });
  }

  return (
    <>
      <div className="panel pad span-12">
        <p className="eyebrow">Current plan</p>
        {error ? <p className="form-error">{error}</p> : null}
        <h2>{plan ? `${plan.account_name} is on ${plan.tier}` : "Loading plan..."}</h2>
        {plan ? (
          <p>{plan.trackings_limit} monthly trackings, {plan.bulk_limit} per bulk request, {plan.rate_limit_per_minute}/min API limit, ${plan.overage_usd_per_tracking.toFixed(2)} overage.</p>
        ) : null}
        <div className="actions"><button className="button" onClick={openPortal} disabled={isPending}>Manage billing</button></div>
        {message ? <p className="form-note">{message}</p> : null}
      </div>
      {tiers.map(([name, price, volume, bulk]) => (
        <div className="panel pad span-3" key={name}>
          <p className="eyebrow">{name}</p>
          <strong style={{ fontSize: 36 }}>{price}</strong>
          <p>{volume} trackings, {bulk}, signed webhooks.</p>
          {plan?.tier.toLowerCase() === name.toLowerCase()
            ? <p className="form-note">Current plan</p>
            : <button className="button" onClick={() => startCheckout(name)} disabled={isPending}>Choose {name}</button>}
        </div>
      ))}
    </>
  );
}
