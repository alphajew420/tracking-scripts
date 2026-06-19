"use client";

import { RotateCcw, Send } from "lucide-react";
import { useEffect, useState, useTransition } from "react";
import { dashboardFetch } from "@/lib/dashboard-api";

type WebhookRow = {
  id: string;
  url: string;
  event_types: string[];
  secret_preview: string;
  created_at: string;
};

type DeliveryRow = {
  id: string;
  webhook_id: string;
  url: string | null;
  event_type: string;
  status: number | null;
  attempts: number;
  error: string | null;
  delivered_at: string | null;
  created_at: string;
};

export function DashboardWebhooks() {
  const [webhooks, setWebhooks] = useState<WebhookRow[]>([]);
  const [deliveries, setDeliveries] = useState<DeliveryRow[]>([]);
  const [selected, setSelected] = useState<WebhookRow | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [isPending, startTransition] = useTransition();

  async function loadWebhooks() {
    const result = await dashboardFetch("/v1/webhooks");
    setWebhooks(result.data ?? []);
  }

  async function loadDeliveries() {
    const result = await dashboardFetch("/v1/webhook-deliveries?limit=25");
    setDeliveries(result.data ?? []);
  }

  useEffect(() => {
    Promise.all([loadWebhooks(), loadDeliveries()]).catch((err) => setError(err.message));
  }, []);

  async function createWebhook(formData: FormData) {
    setError("");
    setMessage("");
    const url = String(formData.get("url") ?? "").trim();
    const eventTypes = String(formData.get("event_types") ?? "tracking.updated,tracking.delivered").split(",").map((event) => event.trim());
    if (!url) {
      setError("Webhook URL is required.");
      return;
    }
    startTransition(async () => {
      try {
        const webhook = await dashboardFetch("/v1/webhooks", {
          method: "POST",
          body: JSON.stringify({ url, event_types: eventTypes }),
        });
        setSelected(webhook);
        setMessage("Webhook endpoint created.");
        await Promise.all([loadWebhooks(), loadDeliveries()]);
      } catch (err) {
        setError((err as Error).message);
      }
    });
  }

  async function testWebhook(id: string) {
    setError("");
    setMessage("");
    startTransition(async () => {
      try {
        const result = await dashboardFetch(`/v1/webhooks/${id}/test`, { method: "POST", body: "{}" });
        setMessage(`Test payload generated. Signature: ${result.signature}`);
        await loadDeliveries();
      } catch (err) {
        setError((err as Error).message);
      }
    });
  }

  return (
    <>
      <form action={createWebhook} className="panel pad span-5">
        <h2>Endpoint</h2>
        <label className="field">URL<input name="url" placeholder="https://example.com/webhooks/tracking" /></label>
        <label className="field">Events<input name="event_types" defaultValue="tracking.updated,tracking.delivered" /></label>
        <label className="field">Signing secret<input value={selected?.secret_preview ?? "Generated after endpoint creation"} readOnly /></label>
        <div className="actions"><button className="button primary" disabled={isPending} type="submit"><Send size={16} /> Create endpoint</button></div>
        {message ? <p className="form-success">{message}</p> : null}
        {error ? <p className="form-error">{error}</p> : null}
      </form>
      <div className="panel span-7 table-wrap">
        {webhooks.length ? (
          <table className="table">
            <thead><tr><th>Endpoint</th><th>Events</th><th>Secret</th><th>Action</th></tr></thead>
            <tbody>
              {webhooks.map((webhook) => (
                <tr key={webhook.id}>
                  <td><strong>{webhook.url}</strong><br />{webhook.id}</td>
                  <td>{webhook.event_types.join(", ")}</td>
                  <td>{webhook.secret_preview}</td>
                  <td><button className="button" onClick={() => testWebhook(webhook.id)}><RotateCcw size={15} /> Test</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty-state">
            <p className="eyebrow">No webhook endpoints</p>
            <h2>Create an endpoint to enable event delivery.</h2>
            <p>The table will show endpoint URL, event types, secret preview, and test controls.</p>
          </div>
        )}
      </div>
      <div className="panel span-12 table-wrap">
        {deliveries.length ? (
          <table className="table">
            <thead><tr><th>Delivery</th><th>Endpoint</th><th>Event</th><th>Result</th><th>Created</th></tr></thead>
            <tbody>
              {deliveries.map((delivery) => (
                <tr key={delivery.id}>
                  <td><strong>{delivery.id}</strong><br />{delivery.webhook_id}</td>
                  <td>{delivery.url ?? "Deleted endpoint"}</td>
                  <td>{delivery.event_type}</td>
                  <td>{delivery.delivered_at ? `Delivered ${delivery.status}` : delivery.error ? `Failed: ${delivery.error}` : "Dry run"}<br />{delivery.attempts} attempts</td>
                  <td>{new Date(delivery.created_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty-state">
            <p className="eyebrow">No delivery records</p>
            <h2>Webhook delivery attempts will appear here.</h2>
            <p>Test events and tracking update events are recorded with endpoint, status, attempts, and error details.</p>
          </div>
        )}
      </div>
    </>
  );
}
