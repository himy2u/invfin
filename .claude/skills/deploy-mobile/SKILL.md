---
name: deploy-mobile
description: Use when building or submitting the invfin mobile app (apps/mobile, Expo/React Native) to TestFlight or Google Play, or debugging an EAS build failure.
---

# Deploy mobile app (iOS + Android via Expo/EAS)

1. Requires an Apple Developer account ($99/yr, under the business's own identity) and a Google
   Play Console account ($25 one-time) — these are set up by the user, not by an agent; Apple/Google
   require a real human/business identity for the account holder.
2. `eas build --platform all --profile preview` for an internal test build; `--profile production`
   for a store-bound build.
3. `eas submit --platform ios` / `--platform android` to push to TestFlight / Play internal testing.
4. Store review: iOS review typically 1-3 days, Android a few hours to 1 day. Expect at least one
   rejection round on the first submission — budget for it, don't promise a same-day launch.
5. Env vars for mobile go through `app.config.ts` + EAS secrets (`eas secret:create`), never
   hardcoded — same discipline as `../rules/secrets-discipline.md`.
