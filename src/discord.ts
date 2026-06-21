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

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: message }),
  });

  return response.ok;
}
