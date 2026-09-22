# Secrets discipline

- Stripe secret keys, Supabase service-role key, Twilio auth token, Postmark/SES API key: env vars
  only (`.env.local`, never committed — confirm `.gitignore` covers it before the first commit).
- Never print, echo, or inline a credential VALUE in code, logs, or chat — reference the variable
  NAME only.
- Client-side (web + Expo) code gets only public/publishable keys (`STRIPE_PUBLISHABLE_KEY`,
  Supabase anon key). Anything that can move money or read all rows goes server-side only.
- Before the first commit of any session, confirm no `.env*` file is staged.
