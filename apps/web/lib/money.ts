/**
 * One place that turns integer cents into money a human reads.
 *
 * Before this existed, every screen did `(cents / 100).toFixed(2)` and pasted the ISO code after
 * it, so real amounts rendered as "2800.00 USD" and "0.00 outstanding", with no symbol and no
 * thousands separator. Two independent naive-user tests flagged it on the same pass.
 *
 * Lives here rather than in `packages/core` for the same reason as lib/reminder-draft.ts: neither
 * app depends on that package yet (it is still the Phase-1 skeleton and Metro/Expo workspace
 * resolution isn't wired up). The mobile counterpart is apps/mobile/lib/money.ts and is kept
 * identical; the moment @invfin/core is actually wired, both move there.
 */

// Pinned rather than the viewer's own locale (`undefined`). These amounts are rendered in server
// components and then hydrated on the client: Node's ICU locale and the browser's are not
// guaranteed to agree, and a formatter that resolves differently on the two sides produces a React
// hydration mismatch on every money figure on the page. The app is English-only today (<html
// lang="en">), so pinning costs nothing and removes the whole class of bug.
const LOCALE = "en-US";

/**
 * Formats integer cents in the bill/invoice's OWN currency, never a hardcoded USD. A detected bill
 * carries whatever currency the vendor billed in, and printing a "$" on a EUR bill is a small lie
 * about the amount owed.
 *
 * Falls back to "<amount> <CODE>" when the code isn't one Intl recognizes. That matters because
 * `currency` on a detected bill comes out of an LLM extraction, so it can be an empty string or
 * something that isn't a real ISO 4217 code, and Intl.NumberFormat throws a RangeError on those
 * rather than degrading, and an uncaught throw in a server component would blank the whole page
 * over a cosmetic detail.
 */
export function formatMoney(cents: number, currency: string | null | undefined): string {
  const amount = (cents ?? 0) / 100;
  const code = (currency ?? "").trim().toUpperCase();

  if (/^[A-Z]{3}$/.test(code)) {
    try {
      return new Intl.NumberFormat(LOCALE, { style: "currency", currency: code }).format(amount);
    } catch {
      // Well-formed but not a currency Intl knows. Fall through to the code-suffixed form.
    }
  }

  const plain = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount);
  return code ? `${plain} ${code}` : plain;
}

/** Thousands separators without a currency, for a bare rate/quantity column that sits under a
 * heading already naming the currency, where repeating the symbol on every row is just noise. */
export function formatAmount(cents: number): string {
  return new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format((cents ?? 0) / 100);
}
