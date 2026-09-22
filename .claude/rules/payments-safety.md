# Payments safety

- **Stripe Connect only.** Never build a custom payment processor, never touch banking rails
  directly, never hold customer or merchant funds in our own database as a balance. Stripe is the
  ledger of record for money; we only store references (payment intent IDs, Connect account IDs).
- **Never mark an invoice "paid" from our own logic alone.** Paid status is set only from a verified
  Stripe webhook event (`payment_intent.succeeded` / `checkout.session.completed`), signature-checked.
  This product's entire pitch is "don't lie to the user about what happened" — the one thing Wave/
  Xero/Square get wrong on delivery, we cannot then get wrong on payment status.
- **Never invent a delivery/payment status.** If a webhook hasn't arrived, the invoice UI shows
  "pending confirmation," not "paid" and not "sent" — silence is a distinct state from success.
- Test webhook handling against Stripe's CLI (`stripe listen --forward-to`) with a real test-mode
  event before trusting any status-transition code path.
