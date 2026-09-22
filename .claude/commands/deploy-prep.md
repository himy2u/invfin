---
description: Pre-deploy checklist for invfin (web or mobile) before shipping.
---

1. `turbo build && turbo test` clean across the monorepo.
2. Confirm target environment (preview vs. production; which Supabase project) with the user.
3. Confirm no `.env*` file is staged (`../rules/secrets-discipline.md`).
4. Follow `../skills/deploy-web/SKILL.md` or `../skills/deploy-mobile/SKILL.md` as applicable.
