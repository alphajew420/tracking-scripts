"use client";

import { Check, Search, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { apiBaseUrl } from "@/lib/site";

type CarrierCandidate = {
  carrier: string;
  confidence: number;
  reason: string;
};

type SampleResponse = {
  accepted: boolean;
  carrier_id: string | null;
  detected_candidates: CarrierCandidate[];
  validation: {
    status: string;
    sample: string | null;
    sample_source: string | null;
    result: string | null;
    efficiency_path: string | null;
  };
  discord_notified: boolean;
  turnstile_verified: boolean | null;
};

const POW_DIFFICULTY = 4;
const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "";

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function hash(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  return toHex(await crypto.subtle.digest("SHA-256", encoded));
}

export function CarrierIntake({
  carrierId,
  carrierName,
  validationStatus,
}: {
  carrierId: string;
  carrierName: string;
  validationStatus: string;
}) {
  const [trackingNumber, setTrackingNumber] = useState("");
  const [candidateCarrier, setCandidateCarrier] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<CarrierCandidate[]>([]);
  const [powNonce, setPowNonce] = useState<string | null>(null);
  const [powProgress, setPowProgress] = useState(0);
  const [powMessage, setPowMessage] = useState("Solve proof-of-work to unlock sample submission.");
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileReady, setTurnstileReady] = useState(false);
  const [status, setStatus] = useState<SampleResponse | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [isPending, startTransition] = useTransition();
  const solveToken = useRef(0);
  const turnstileContainer = useRef<HTMLDivElement | null>(null);

  const apiRoot = useMemo(() => apiBaseUrl().replace(/\/$/, ""), []);

  useEffect(() => {
    if (!TURNSTILE_SITE_KEY) return;
    let cancelled = false;
    const existing = document.querySelector<HTMLScriptElement>("script[data-trackified-turnstile='true']");
    if (existing) {
      setTurnstileReady(Boolean((window as typeof window & { turnstile?: { render: Function } }).turnstile));
      return;
    }
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.defer = true;
    script.dataset.trackifiedTurnstile = "true";
    script.onload = () => {
      if (!cancelled) setTurnstileReady(true);
    };
    document.head.appendChild(script);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!TURNSTILE_SITE_KEY || !turnstileReady || !turnstileContainer.current) return;
    const turnstile = (window as typeof window & {
      turnstile?: {
        render: (element: HTMLElement, options: { sitekey: string; callback: (token: string) => void }) => string;
        reset?: (widgetId: string) => void;
      };
    }).turnstile;
    if (!turnstile) return;
    turnstileContainer.current.innerHTML = "";
    const widgetId = turnstile.render(turnstileContainer.current, {
      sitekey: TURNSTILE_SITE_KEY,
      callback: (token: string) => setTurnstileToken(token),
    });
    return () => {
      if (turnstile.reset) turnstile.reset(widgetId);
    };
  }, [turnstileReady]);

  useEffect(() => {
    if (!trackingNumber.trim()) {
      setCandidates([]);
      setCandidateCarrier(null);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`${apiRoot}/v1/carriers/detect?number=${encodeURIComponent(trackingNumber.trim())}`, {
          signal: controller.signal,
        });
        if (!response.ok) return;
        const payload = (await response.json()) as { candidates?: CarrierCandidate[] };
        const nextCandidates = payload.candidates ?? [];
        setCandidates(nextCandidates);
        setCandidateCarrier(nextCandidates[0]?.carrier ?? null);
      } catch {
        setCandidates([]);
        setCandidateCarrier(null);
      }
    }, 250);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [apiRoot, trackingNumber]);

  async function solvePow() {
    const number = trackingNumber.trim();
    if (!number) {
      setError("Enter a tracking number first.");
      return;
    }

    const attemptId = solveToken.current + 1;
    solveToken.current = attemptId;
    setError("");
    setPowProgress(0);
    setPowMessage(`Solving ${POW_DIFFICULTY}-hex proof-of-work...`);
    const prefix = "0".repeat(POW_DIFFICULTY);

    for (let nonce = 0; nonce < 400000; nonce += 1) {
      if (solveToken.current !== attemptId) return;
      const digest = await hash(`${carrierId}:${number}:${nonce}`);
      if (digest.startsWith(prefix)) {
        setPowNonce(String(nonce));
        setPowProgress(100);
        setPowMessage(`Proof-of-work solved with nonce ${nonce}.`);
        return;
      }
      if (nonce % 5000 === 0) {
        setPowProgress(Math.min(99, Math.round((nonce / 400000) * 100)));
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      }
    }

    setPowProgress(0);
    setPowMessage("Proof-of-work did not resolve. Try again.");
  }

  async function submitSample() {
    const number = trackingNumber.trim();
    if (!number) {
      setError("Tracking number is required.");
      return;
    }
    if (!powNonce) {
      setError("Solve the proof-of-work challenge first.");
      return;
    }
    if (TURNSTILE_SITE_KEY && !turnstileToken) {
      setError("Complete the Turnstile challenge first.");
      return;
    }

    setError("");
    setMessage("");
    setStatus(null);

    startTransition(async () => {
      try {
        const response = await fetch(`${apiRoot}/v1/public/carrier-samples`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            carrier_id: carrierId,
            carrier_name: carrierName,
            tracking_number: number,
            source_url: window.location.href,
            pow_nonce: powNonce,
            turnstile_token: turnstileToken,
          }),
        });
        const payload = (await response.json()) as SampleResponse & { error?: { message?: string } };
        if (!response.ok) {
          throw new Error(payload?.error?.message ?? "Unable to submit sample.");
        }
        setStatus(payload);
        setMessage(
          payload.accepted
            ? "Sample logged. If it is a real shipment, it is now queued for validation."
            : "Sample received.",
        );
      } catch (err) {
        setError((err as Error).message);
      }
    });
  }

  const topCandidate = candidates[0]?.carrier ?? null;
  const liveHint =
    topCandidate && topCandidate !== carrierId
      ? `Auto-detect thinks this looks more like ${topCandidate.toUpperCase()}.`
      : candidateCarrier
        ? `${carrierName} is the current best match.`
        : "Auto-detection will update as you type.";

  return (
    <section className="carrier-intake-grid">
      <article className="panel pad carrier-intake-panel">
        <p className="eyebrow">Carrier readiness</p>
        <h2>{carrierName} validation status</h2>
        <div className={`carrier-status-chip ${validationStatus}`}>
          <span />
          <strong>{validationStatus.replaceAll("_", " ")}</strong>
        </div>
        <p>{liveHint}</p>
        <p className="form-note">
          Real samples are logged for validation and Discord notification. The frontend challenge keeps casual abuse
          out without blocking the API itself.
        </p>
      </article>

      <form
        className="panel pad carrier-intake-panel carrier-intake-form"
        onSubmit={(event) => {
          event.preventDefault();
          submitSample();
        }}
      >
        <p className="eyebrow">Track a number</p>
        <h2>Detect the carrier and queue a sample</h2>
        <label className="field">
          Tracking number
          <div className="input-icon">
            <Search size={16} />
            <input
              value={trackingNumber}
              onChange={(event) => {
                setTrackingNumber(event.target.value);
                setPowNonce(null);
                setTurnstileToken(null);
                setPowProgress(0);
                setPowMessage("Solve proof-of-work to unlock sample submission.");
              }}
              placeholder="Enter any tracking number"
            />
          </div>
        </label>

        <div className="carrier-detect-stack">
          {candidates.length ? (
            candidates.slice(0, 3).map((candidate) => (
              <div key={candidate.carrier} className={`carrier-detect-row ${candidate.carrier === carrierId ? "active" : ""}`}>
                <strong>{candidate.carrier}</strong>
                <span>{Math.round(candidate.confidence * 100)}%</span>
              </div>
            ))
          ) : (
            <div className="carrier-detect-empty">Carrier candidates will appear here after a few characters.</div>
          )}
        </div>

        <button className="button" type="button" onClick={solvePow} disabled={!trackingNumber.trim() || isPending}>
          <Sparkles size={16} /> Solve proof-of-work
        </button>
        <div className="pow-meter" aria-hidden="true">
          <span style={{ width: `${powProgress}%` }} />
        </div>
        <p className="form-note">{powMessage}</p>

        {TURNSTILE_SITE_KEY ? (
          <div className="turnstile-shell">
            <p className="eyebrow">Cloudflare Turnstile</p>
            <div ref={turnstileContainer} className="turnstile-placeholder" />
            <p className="form-note">
              {turnstileToken ? "Turnstile token captured." : turnstileReady ? "Complete the widget to unlock submit." : "Loading Turnstile widget..."}
            </p>
          </div>
        ) : (
          <p className="form-note">Turnstile is wired and will activate when `NEXT_PUBLIC_TURNSTILE_SITE_KEY` is set.</p>
        )}

        <button className="button primary" type="submit" disabled={isPending || !trackingNumber.trim() || !powNonce || (Boolean(TURNSTILE_SITE_KEY) && !turnstileToken)}>
          <Check size={16} /> {isPending ? "Submitting..." : "Log sample"}
        </button>

        {message ? <p className="form-success">{message}</p> : null}
        {error ? <p className="form-error">{error}</p> : null}
        {status ? (
          <div className="carrier-submit-result">
            <strong>{status.accepted ? "Queued for testing" : "Received"}</strong>
            <span>Validation: {status.validation.status.replaceAll("_", " ")}</span>
            <span>{status.discord_notified ? "Discord notified" : "Discord webhook not configured"}</span>
          </div>
        ) : null}
      </form>
    </section>
  );
}
