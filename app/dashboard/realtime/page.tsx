import { Radio } from "lucide-react";
import { AppShell } from "../../../components/app-shell";

export default function RealtimePage() {
  return (
    <AppShell active="/dashboard/realtime">
      <div className="topbar"><div><p className="eyebrow">Realtime</p><h1>WebSocket subscriptions for consoles, widgets, and agents.</h1></div></div>
      <section className="panel pad">
        <h2><Radio size={20} /> Stream endpoint</h2>
        <pre style={{ overflow: "auto", background: "var(--ink)", color: "white", padding: 14, borderRadius: 7 }}>{`wss://api.yourdomain.com/v1/stream?api_key=live_...

> {"type":"subscribe","tracking_id":"trk_..."}
< {"type":"event","tracking_id":"trk_...","event":{...}}`}</pre>
      </section>
    </AppShell>
  );
}
