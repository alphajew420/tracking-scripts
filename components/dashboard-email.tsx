"use client";

import { useEffect, useState } from "react";
import { dashboardFetch } from "@/lib/dashboard-api";

type EmailRow = {
  id: string;
  to_email: string;
  subject: string;
  body: string;
  provider: string;
  status: string;
  error: string | null;
  sent_at: string | null;
  created_at: string;
};

export function DashboardEmail() {
  const [emails, setEmails] = useState<EmailRow[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    dashboardFetch("/v1/account/email-outbox?limit=50")
      .then((result) => setEmails(result.data ?? []))
      .catch((err) => setError(err.message));
  }, []);

  if (error) return <div className="panel pad span-12"><p className="form-error">{error}</p></div>;

  return (
    <div className="panel span-12 table-wrap">
      {emails.length ? (
        <table className="table">
          <thead><tr><th>Recipient</th><th>Subject</th><th>Status</th><th>Body</th></tr></thead>
          <tbody>
            {emails.map((email) => (
              <tr key={email.id}>
                <td><strong>{email.to_email}</strong><br />{email.provider}</td>
                <td>{email.subject}<br />{new Date(email.created_at).toLocaleString()}</td>
                <td>{email.status}{email.error ? <><br />{email.error}</> : null}</td>
                <td><code>{email.body}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="empty-state">
          <p className="eyebrow">No email yet</p>
          <h2>Verification, invite, and password reset emails will appear here.</h2>
          <p>Use this as the local development outbox, or as a production audit surface when a provider is connected.</p>
        </div>
      )}
    </div>
  );
}
