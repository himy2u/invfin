---
name: stripe-connect-setup
description: Use when wiring up Stripe Connect for invfin (platform account, onboarding merchants, payment links) or debugging a Connect onboarding/payout issue.
---

# Stripe Connect setup

1. Platform Stripe account is created by the user (requires their business's legal identity, bank
   account, tax ID) — this is not something an agent can do on someone's behalf.
2. Use **Standard** or **Express** Connect accounts for merchants (invfin's users), not Custom —
   Custom means we own compliance/KYC, which is out of scope for v1.
3. Onboarding flow: `stripe.accountLinks.create` → redirect merchant to Stripe-hosted onboarding →
   webhook `account.updated` confirms `charges_enabled`/`payouts_enabled` before we let them send a
   live invoice.
4. Payment link per invoice: `stripe.checkout.sessions.create` on the connected account
   (`stripeAccount: acct_id` param), metadata carries our internal `invoice_id` for webhook
   reconciliation.
5. See `../../rules/payments-safety.md` for the invariant: invoice status only changes on a
   verified webhook, never optimistically.
