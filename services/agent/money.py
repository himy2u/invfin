"""Rendering an amount inside a notification body.

A reminder that said "Kestrel PM is due 2026-09-30" and nothing else was the single most-noted gap in
live testing: the one number that decides whether the user acts on it today was missing. This is the
one place that turns (cents, currency) into the string that goes in a reminder title/body, so the real
reminder path and the test-reminder path cannot drift into saying it differently.

Deliberately NOT babel/locale machinery. The service has no user locale to key off (there is no
timezone or locale column anywhere in this schema; see the note in reminder_scheduling.py), so the
alternative to a small symbol table is a dependency that would still have to be told which locale to
use and would guess wrong just as often.
"""

# The currencies this product actually sees on forwarded bills. Everything else falls back to the ISO
# code, which is unambiguous even if it's less pretty. The failure mode to avoid is printing "$" on a
# bill denominated in something that isn't dollars.
_SYMBOLS = {
    "USD": "$",
    "EUR": "€",
    "GBP": "£",
    "JPY": "¥",
    "INR": "₹",
    "CAD": "CA$",
    "AUD": "A$",
    "NZD": "NZ$",
    "CHF": "CHF ",
    "SEK": "SEK ",
    "SGD": "S$",
    "HKD": "HK$",
    "ZAR": "R",
    "AED": "AED ",
    "BRL": "R$",
    "MXN": "MX$",
}

# Currencies with no minor unit. Printing "¥1,200.00" is wrong in a way a Japanese user notices
# immediately, and our cents column holds whole yen for these.
_ZERO_DECIMAL = frozenset({"JPY", "KRW", "VND", "CLP", "ISK"})


def format_money(cents: int | None, currency: str | None) -> str:
    """'$1,248.60' / '1,248.60 NOK', never a bare '1248.60'."""
    code = (currency or "").strip().upper()
    amount = (cents or 0) / 100

    if code in _ZERO_DECIMAL:
        body = f"{round(amount):,}"
    else:
        body = f"{amount:,.2f}"

    symbol = _SYMBOLS.get(code)
    if symbol:
        return f"{symbol}{body}"
    return f"{body} {code}" if code else body
