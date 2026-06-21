export interface BrowserProxy {
  server: string;
  username?: string;
  password?: string;
}

interface ProxyOptions {
  session?: string;
  country?: string;
}

export function proxyForCarrier(carrierId: string, opts: ProxyOptions = {}): BrowserProxy | undefined {
  const key = `PROXY_${carrierId.toUpperCase().replaceAll("-", "_")}`;
  const server = process.env[key] ?? process.env.PROXY_DEFAULT;
  if (!server) return undefined;

  const username =
    renderTemplate(process.env[`${key}_USERNAME_TEMPLATE`], carrierId, opts) ??
    process.env[`${key}_USERNAME`] ??
    renderTemplate(process.env.PROXY_DEFAULT_USERNAME_TEMPLATE, carrierId, opts) ??
    process.env.PROXY_DEFAULT_USERNAME;

  const password = process.env[`${key}_PASSWORD`] ?? process.env.PROXY_DEFAULT_PASSWORD;
  return { server, username, password };
}

function renderTemplate(
  template: string | undefined,
  carrierId: string,
  opts: ProxyOptions,
): string | undefined {
  if (!template) return undefined;
  const session = opts.session ?? process.env.PROXY_SESSION ?? carrierId;
  const country = opts.country ?? process.env.PROXY_COUNTRY ?? "";
  return template
    .replaceAll("{carrier}", carrierId)
    .replaceAll("{session}", session)
    .replaceAll("{country}", country);
}
