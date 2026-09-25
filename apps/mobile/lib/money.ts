/**
 * One place that turns integer cents into money a human reads. The mobile counterpart of
 * apps/web/lib/money.ts, kept in step with it.
 *
 * Neither lives in `packages/core` yet for the same reason as lib/reminder-draft.ts: neither app
 * depends on that package at all today (it is still the Phase-1 skeleton and Metro/Expo workspace
 * resolution isn't wired up). The one difference from the web file is the Intl fallback below, which
 * exists because a Hermes build without full ICU is a real possibility on Android.
 */

// Pinned, matching web. The app is English-only today, and a locale that resolves differently per
// device would mean the same bill reads as a different number on a phone than in the browser.
const LOCALE = "en-US";

export function formatMoney(cents: number, currency: string | null | undefined): string {
  const amount = (cents ?? 0) / 100;
  const code = (currency ?? "").trim().toUpperCase();

  if (/^[A-Z]{3}$/.test(code)) {
    try {
      return new Intl.NumberFormat(LOCALE, { style: "currency", currency: code }).format(amount);
    } catch {
      // Either a well-formed code Intl doesn't know, or a Hermes build without the currency data.
      // Fall through rather than crash a screen over a cosmetic detail.
    }
  }

  return code ? `${formatAmount(cents)} ${code}` : formatAmount(cents);
}

export function formatAmount(cents: number): string {
  const amount = (cents ?? 0) / 100;
  try {
    return new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount);
  } catch {
    // Last-resort grouping by hand, for a Hermes build with no Intl at all. Same output shape as
    // Intl's en-US for every value this app deals with.
    const [whole, fraction] = amount.toFixed(2).split(".");
    const sign = whole.startsWith("-") ? "-" : "";
    const digits = sign ? whole.slice(1) : whole;
    return `${sign}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction}`;
  }
}
