# PRD: invoicing that's fast to make and impossible to lose

**Status: HYPOTHESIS, not validated.** Desk research only — no prospect talked to, no payment taken
yet. Don't treat scope/pricing/buyer as settled. See `../plans/mvp-build-plan.md` Phase 0.

## Problem

Wave/Xero/Square force a tradeoff: a slow, form-heavy way to create an invoice, or a fast one that
then silently fails to get seen/paid with no warning (confirmed via Reddit/Trustpilot/app-store
research, Sep 2026 — Xero: spam/deliverability; Wave: silent send failures; Square: no fix-after-
send). 59% of SMBs sit on ~$17.7K overdue, 9 days late avg (QuickBooks 2026 report) — losing an
invoice in transit guarantees a late payment.

## v1 — what the user achieves, in order

1. **Bill someone in under a minute** — type it ("bill Acme $500 for design work"), pick it from a
   photo/PDF of an old invoice, or fill a short form. Three ways in, one invoice out.
2. **Never redo the same invoice twice** — saved clients, saved line items/services, reused terms
   & notes.
3. **Charge tax and give a discount without doing math** — per-line tax rate (inclusive or
   exclusive), % or flat discount.
4. **Set it and forget it** — due date/payment terms (Net 15/30/60), auto-reminders, recurring
   invoices for repeat clients.
5. **Get paid however much, whenever** — full or partial payment via Stripe; a partial payment
   shows what's still owed, not a stuck "unpaid."
6. **Send a quote, turn it into an invoice with one click** once the client approves — no retyping.
7. **Know what actually happened** — status is draft → sent → delivered → viewed → paid, not just
   "sent." If email bounces or sits unopened 48h, it auto-retries by SMS/WhatsApp, same pay link.
8. **Fix a mistake without a mess** — void an invoice (kept in the record, distinct from delete);
   void/remind in bulk, not one-by-one (the exact thing Xero can't do).
9. **See who owes you money at a glance** — one screen: outstanding total, aging (how late),
   by client.
10. **Bring your history with you** — import existing invoices/clients from a CSV, PDF, or another
    tool's export, so switching costs nothing.

## AR only in v1 (not AP)

We build **invoices you send** (money owed to the user), not **bills you owe** (accounts payable).
Direction is decided by contact role (Customer vs. Vendor), so adding Bills later reuses the same
data model instead of a rework. Imported documents get a direction confirmed by the user, never
auto-classified silently.

## Explicitly NOT in v1

Bills/accounts payable, full bookkeeping ledger, bank feed sync, inventory, payroll, multi-currency,
client-facing payment portal, multi-user/team roles, custom branding beyond logo+color.

## Target buyer (day-1 revenue)

**Small/medium businesses and startups with real invoicing volume — not solo freelancers.** Two
reachable segments within that: (1) new SMBs/startups invoicing for the first time, (2) frustrated
Wave/Xero/Square SMB users — previously excluded for switching cost, now reachable because import
(#10 above) removes it. See `../plans/day1-revenue-plan.md` for channels (no Reddit — ban risk;
accountant/bookkeeper partners, LinkedIn, cold email, comparison content, warm network instead).

## Pricing

Not a flat per-seat subscription. Usage/outcome/activation-based, tracking whatever's in the
contract — e.g. per invoice sent, per client activated — decided with real pilot customers in
Phase 0, not fixed in advance. Validation-stage offer only: a **$10 one-time** early-access fee
(low-friction ask, not a subscription commitment) to get a real payment signal before the product
exists — see `../plans/mvp-build-plan.md` Phase 0.

## v1.1 idea (not v1 — one line, revisit later)

Expose invoice creation/status as an API/MCP tool, not just a human UI, so a user's own AI
assistant (or eventually their client's) can create/send/check an invoice programmatically —
natural extension of the agentic creation mode already in v1, without betting on speculative
agent-to-agent payment infrastructure.
