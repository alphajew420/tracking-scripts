export const dashboardApiBase =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "https://api.trackified.15-204-158-166.sslip.io";

export async function dashboardFetch(path: string, init: RequestInit = {}) {
  const response = await fetch(`${dashboardApiBase}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(data?.error?.message ?? `Request failed: ${response.status}`);
  }
  return data;
}
