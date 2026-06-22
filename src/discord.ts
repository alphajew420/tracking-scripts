function envValue(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key];
    if (value) return value;
  }
  return undefined;
}

export async function sendDiscordWebhook(message: string): Promise<boolean> {
  const webhookUrl = envValue("DISCORD_CARRIER_WEBHOOK_URL", "DISCORD_WEBHOOK_URL");
  if (!webhookUrl) return false;
  const timeoutMs = Number(process.env.DISCORD_WEBHOOK_TIMEOUT_MS ?? 5000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: message }),
      signal: controller.signal,
    });

    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
