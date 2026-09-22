import pino from "pino";

const base = pino({
  level: process.env.LOG_LEVEL ?? "info",
  transport:
    process.env.NODE_ENV !== "production"
      ? { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } }
      : undefined,
});

// Every server-side log call should go through a request-scoped child logger so log lines can
// be correlated with the same request across the browser console and services/agent — see
// middleware.ts for where x-request-id originates.
export function loggerFor(requestId: string) {
  return base.child({ requestId });
}
