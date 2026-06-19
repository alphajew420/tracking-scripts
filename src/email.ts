import { randomUUID } from "node:crypto";
import { query } from "./db.ts";

export interface EmailMessage {
  accountId?: string | null;
  to: string;
  subject: string;
  body: string;
}

export async function sendEmail(message: EmailMessage): Promise<void> {
  const provider = process.env.EMAIL_PROVIDER ?? "dev";
  const id = `eml_${randomUUID().replaceAll("-", "")}`;
  await query(
    `insert into email_outbox (id, account_id, to_email, subject, body, provider, status, created_at)
     values ($1, $2, $3, $4, $5, $6, 'queued', now())`,
    [id, message.accountId ?? null, message.to, message.subject, message.body, provider],
  );

  if (provider === "dev") {
    await query(`update email_outbox set status = 'sent', sent_at = now() where id = $1`, [id]);
    return;
  }

  if (provider === "resend") {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.EMAIL_FROM ?? "Trackified <no-reply@trackified.dev>";
    if (!apiKey) throw new Error("RESEND_API_KEY is required when EMAIL_PROVIDER=resend");
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ from, to: message.to, subject: message.subject, text: message.body }),
    });
    if (!response.ok) {
      const text = await response.text();
      await query(`update email_outbox set status = 'failed', error = $2 where id = $1`, [id, text]);
      throw new Error(`email send failed: ${response.status}`);
    }
    await query(`update email_outbox set status = 'sent', sent_at = now() where id = $1`, [id]);
    return;
  }

  throw new Error(`unsupported EMAIL_PROVIDER: ${provider}`);
}

export function appUrl(path: string): string {
  const base = process.env.APP_BASE_URL ?? "http://localhost:3017";
  return `${base}${path}`;
}
