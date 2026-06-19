"use client";

import Link from "next/link";
import { Search } from "lucide-react";
import { useDeferredValue, useState } from "react";
import type { CarrierRecord } from "@/lib/marketing";

export function CarrierSearch({ carriers }: { carriers: CarrierRecord[] }) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const needle = deferredQuery.trim().toLowerCase();
  const filtered = carriers.filter((carrier) => {
    if (!needle) return true;
    const haystack = [
      carrier.name,
      carrier.region,
      carrier.tier,
      carrier.status,
      ...carrier.services,
      ...carrier.formats,
      ...carrier.eventCoverage,
      ...carrier.bestFor,
    ].join(" ").toLowerCase();
    return haystack.includes(needle);
  });

  return (
    <section className="carrier-search-block">
      <div className="carrier-search-head">
        <div>
          <p className="eyebrow">Live carrier search</p>
          <h2>Search active carrier coverage.</h2>
        </div>
        <label className="carrier-search-box">
          <Search size={18} />
          <span className="sr-only">Search carriers</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by carrier, region, service, or event..."
          />
        </label>
      </div>

      <div className="carrier-directory">
        {filtered.map((carrier) => (
          <Link href={`/carriers/${carrier.id}`} key={carrier.id} className="carrier-card live-coverage">
            <div>
              <small>{carrier.tier}</small>
              <em>{carrier.status}</em>
            </div>
            <strong>{carrier.name}</strong>
            <span>{carrier.region}</span>
            <p>{carrier.summary}</p>
            <b>{carrier.eventCoverage.length} normalized event types</b>
          </Link>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="carrier-empty">
          <h3>No live carrier match</h3>
          <p>Try a carrier name, region, service level, or event type.</p>
        </div>
      ) : null}
    </section>
  );
}
