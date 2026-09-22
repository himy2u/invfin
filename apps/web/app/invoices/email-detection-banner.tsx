import Link from "next/link";

export function EmailDetectionBanner() {
  return (
    <Link
      href="/connect-email"
      className="mb-6 flex items-center gap-4 rounded-xl border border-teal-100 bg-teal-50 p-4 hover:bg-teal-100"
      data-testid="email-detection-banner"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-teal-700 text-lg text-white">
        ✉️
      </span>
      <div className="flex-1">
        <p className="text-sm font-semibold text-teal-900">Catch bills from your inbox automatically</p>
        <p className="text-xs text-teal-700">
          Forward bill emails to a private address and we&apos;ll add them here for review. Reminders are on by
          default, and you can turn either off anytime.
        </p>
      </div>
      <span
        data-testid="enable-email-detection-button"
        className="shrink-0 rounded-lg bg-teal-700 px-4 py-2 text-sm font-medium text-white"
      >
        Set up
      </span>
    </Link>
  );
}
