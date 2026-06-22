function parseList(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function carrierDisabled(carrier: string | null | undefined): boolean {
  if (!carrier) return false;
  return parseList(process.env.DISABLED_CARRIERS).has(carrier.toLowerCase());
}
