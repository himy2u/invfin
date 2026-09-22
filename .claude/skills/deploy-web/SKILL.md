---
name: deploy-web
description: Use when deploying or previewing the invfin web app (apps/web) to Vercel, or debugging a failed web deploy.
---

# Deploy web app

1. `turbo build --filter=web` locally first — catch build failures before pushing.
2. Push to the branch connected to the Vercel project; Vercel auto-builds a preview deploy per PR.
3. Env vars (`STRIPE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `POSTMARK_API_KEY`, `TWILIO_*`) are
   set in the Vercel project dashboard per environment (Preview / Production) — never in a
   committed file. See `../rules/secrets-discipline.md`.
4. Production promotion is a Vercel dashboard action (or `vercel --prod` if the CLI is configured)
   — confirm with the user before promoting to production.
5. If a deploy fails, check the Vercel build log first; most failures are a missing env var or a
   TypeScript error that `turbo build` should have already caught locally.
