---
description: Review pending changes against invfin's rules before showing/committing them.
---

Check the current diff against:
- `../rules/payments-safety.md` — any status-transition logic on invoice paid/sent state?
- `../rules/secrets-discipline.md` — any credential value, `.env` file staged?
- `../rules/coding-standards.md` — TS strict, no unexplained `any`, no duplicated shared logic?

Report findings; fix before showing the work as done.
