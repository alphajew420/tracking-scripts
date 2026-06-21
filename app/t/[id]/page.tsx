import { notFound } from "next/navigation";
import { apiBaseUrl } from "@/lib/site";

type PublicTracking = {
  id: string;
  tracking_number: string;
  carrier: string | null;
  status: string;
  estimated_delivery: string | null;
  delivered_at: string | null;
  service_level: string | null;
  exception: string | null;
  events: { occurred_at?: string; status?: string; location?: string; description?: string }[];
  updated_at: string;
  brand: { name: string; accent_color: string; support_url: string | null };
};

async function getTracking(id: string): Promise<PublicTracking> {
  const base = process.env.API_INTERNAL_BASE_URL ?? apiBaseUrl().replace(/^https?:\/\//, "http://");
  const response = await fetch(`${base}/public/trackings/${id}`, { cache: "no-store" });
  if (response.status === 404) notFound();
  if (!response.ok) throw new Error("Unable to load tracking page");
  return response.json();
}

export default async function PublicTrackingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tracking = await getTracking(id);
  return (
    <main className="tracking-page" style={{ padding: 0, ["--accent" as string]: tracking.brand.accent_color }}>
      <section className="public-hero">
        <div>
          <p className="eyebrow">{tracking.brand.name} tracking</p>
          <h1>{tracking.status.replaceAll("_", " ")}</h1>
          <p>{tracking.carrier ?? "Carrier pending"} package {tracking.tracking_number}</p>
          {tracking.brand.support_url ? <a className="button primary" href={tracking.brand.support_url}>Contact support</a> : null}
        </div>
      </section>
      <section className="grid" style={{ padding: 28 }}>
        <div className="panel pad span-4">
          <p className="eyebrow">Current status</p>
          <h2>{tracking.status.replaceAll("_", " ")}</h2>
          <p>{tracking.service_level ?? "Service level pending"}</p>
          <p>Last updated {new Date(tracking.updated_at).toLocaleString()}</p>
          {tracking.estimated_delivery ? <p>Estimated delivery {new Date(tracking.estimated_delivery).toLocaleDateString()}</p> : null}
          {tracking.delivered_at ? <p>Delivered {new Date(tracking.delivered_at).toLocaleString()}</p> : null}
          {tracking.exception ? <p className="form-error">{tracking.exception}</p> : null}
        </div>
        <div className="panel pad span-8">
          <h2>Timeline</h2>
          {tracking.events.length ? (
            <div className="rail" style={{ marginTop: 18 }}>
              {tracking.events.map((event, index) => (
                <article className="rail-item" key={`${event.occurred_at ?? "event"}-${index}`}>
                  <strong>{event.description ?? event.status ?? "Tracking event"}</strong>
                  <p>{event.location ?? "Location pending"}</p>
                  <span>{event.occurred_at ? new Date(event.occurred_at).toLocaleString() : "Time pending"}</span>
                </article>
              ))}
            </div>
          ) : (
            <div className="empty-state compact" style={{ marginTop: 18 }}>
              <p>Timeline events will appear after the carrier returns shipment updates.</p>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
