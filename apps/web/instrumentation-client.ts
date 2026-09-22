import posthog from "posthog-js";

// Next.js auto-loads instrumentation-client.ts before any client code runs. No-ops until
// NEXT_PUBLIC_POSTHOG_KEY exists — see .env.*.example. Capture calls elsewhere (e.g.
// invoice-created in new-invoice-form.tsx) are safe to fire unconditionally; posthog-js just
// queues/drops them if the key was never set.
if (process.env.NEXT_PUBLIC_POSTHOG_KEY) {
  posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY, {
    api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com",
    person_profiles: "identified_only",
    capture_pageview: true,
  });
}

export { posthog };
