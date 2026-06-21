function envValue(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key];
    if (value) return value;
  }
  return undefined;
}

export function webBaseUrl(): string {
  return (
    envValue("APP_BASE_URL", "PUBLIC_WEB_BASE_URL", "NEXT_PUBLIC_APP_BASE_URL", "NEXT_PUBLIC_WEB_BASE_URL") ??
    "http://localhost:3017"
  );
}

export function apiBaseUrl(): string {
  return envValue("API_PUBLIC_BASE_URL", "NEXT_PUBLIC_API_BASE_URL") ?? "https://api.trackified.15-204-158-166.sslip.io";
}

export function appUrl(path: string): string {
  return `${webBaseUrl()}${path}`;
}

export function apiUrl(path: string): string {
  return `${apiBaseUrl()}${path}`;
}

export function stripScheme(url: string): string {
  return url.replace(/^https?:\/\//, "");
}
