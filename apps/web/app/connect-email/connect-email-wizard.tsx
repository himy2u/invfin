"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";

const FORWARDING_DOMAIN = process.env.NEXT_PUBLIC_EMAIL_FORWARDING_DOMAIN;
type Channels = { push: boolean; email: boolean; in_app: boolean };

function StatusLine({ done, active, label }: { done: boolean; active?: boolean; label: string }) {
  return (
    <li
      className={`flex items-center gap-2 text-sm ${
        done ? "text-teal-700" : active ? "font-medium text-zinc-900" : "text-zinc-400"
      }`}
    >
      <span
        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] ${
          done ? "bg-teal-700 text-white" : active ? "border-2 border-zinc-900" : "border border-zinc-300"
        }`}
      >
        {done ? "✓" : ""}
      </span>
      {label}
    </li>
  );
}

export function ConnectEmailWizard({
  userId,
  initial,
}: {
  userId: string;
  initial: {
    enabled: boolean;
    forwardingToken: string | null;
    reminderDaysBefore: number;
    channels: Channels;
    sourceEmail: string | null;
  };
}) {
  const supabase = createClient();
  const [enabled, setEnabled] = useState(initial.enabled);
  const [forwardingToken, setForwardingToken] = useState(initial.forwardingToken);
  const [reminderDaysBefore, setReminderDaysBefore] = useState(initial.reminderDaysBefore);
  const [channels, setChannels] = useState<Channels>(initial.channels);
  const [sourceEmail, setSourceEmail] = useState(initial.sourceEmail ?? "");
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirmationLink, setConfirmationLink] = useState<string | null>(null);
  const [confirmClicked, setConfirmClicked] = useState(false);
  const [hasDetectedBill, setHasDetectedBill] = useState(false);
  const [recentBills, setRecentBills] = useState<
    { id: string; vendor_name: string; total_cents: number; currency: string; due_date: string | null; status: string; reminder_days_before: number }[]
  >([]);
  const [starting, setStarting] = useState(false);
  const [testStatus, setTestStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [reminderTestStatus, setReminderTestStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [copied, setCopied] = useState(false);
  const [showGmailSteps, setShowGmailSteps] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveSeq = useRef(0);

  const forwardingAddress = forwardingToken ? `${forwardingToken}@${FORWARDING_DOMAIN}` : null;

  async function getStarted() {
    if (!sourceEmail.trim() || !sourceEmail.includes("@")) {
      setError("Enter the email address where your bills and invoices are received.");
      return;
    }
    if (!acknowledged) {
      setError("Please check the acknowledgment below before continuing.");
      return;
    }
    setStarting(true);
    setError(null);
    const { data, error } = await supabase
      .from("email_forwarding_addresses")
      .upsert({ user_id: userId, enabled: true, source_email: sourceEmail.trim() }, { onConflict: "user_id" })
      .select("forwarding_token, enabled")
      .single();
    setStarting(false);
    if (error) {
      setError(error.message);
      return;
    }
    setEnabled(data.enabled);
    setForwardingToken(data.forwarding_token);
  }

  async function sendTestBill() {
    setTestStatus("sending");
    try {
      const res = await fetch("/api/send-test-bill", { method: "POST" });
      setTestStatus(res.ok ? "sent" : "error");
    } catch {
      setTestStatus("error");
    }
  }

  async function sendTestReminder() {
    setReminderTestStatus("sending");
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("not signed in");
      const res = await fetch(`${process.env.NEXT_PUBLIC_AGENT_SERVICE_URL}/send-test-reminder`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      setReminderTestStatus(res.ok ? "sent" : "error");
    } catch {
      setReminderTestStatus("error");
    }
  }

  async function turnOff() {
    if (!window.confirm("Turn off automatic bill detection? Forwarded emails will no longer be scanned.")) {
      return;
    }
    setError(null);
    const { error } = await supabase.from("email_forwarding_addresses").update({ enabled: false }).eq("user_id", userId);
    if (error) {
      setError(error.message);
      return;
    }
    setEnabled(false);
  }

  // Polls for Gmail's forwarding-confirmation notification and for any newly detected bill.
  // Confirming in Gmail is for the user's own benefit, not a prerequisite for detection. A live
  // naive-user test found that leaving this unresolved read as "setup failed" to a real user.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const poll = async () => {
      if (!confirmationLink) {
        const { data } = await supabase
          .from("notifications")
          .select("body")
          .eq("user_id", userId)
          .eq("type", "gmail_confirmation")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (!cancelled && data) {
          const match = data.body.match(/(https:\/\/mail[a-z.-]*\.google\.com\/mail\/vf-\S+)/);
          if (match) setConfirmationLink(match[1]);
        }
      }
      const { data: bills } = await supabase
        .from("bills")
        .select("id, vendor_name, total_cents, currency, due_date, status, reminder_days_before")
        .eq("source", "email")
        .order("created_at", { ascending: false })
        .limit(5);
      if (!cancelled && bills) {
        setRecentBills(bills);
        if (bills.length > 0) setHasDetectedBill(true);
      }
    };
    poll();
    const interval = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [enabled, confirmationLink, hasDetectedBill, supabase, userId]);

  function saveReminderPrefs(days: number, nextChannels: Channels) {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const mySeq = ++saveSeq.current;
    saveTimer.current = setTimeout(async () => {
      const { error } = await supabase
        .from("profiles")
        .upsert(
          { user_id: userId, reminder_days_before_default: days, reminder_channels: nextChannels },
          { onConflict: "user_id" },
        );
      if (mySeq !== saveSeq.current) return;
      if (error) setError(error.message);
    }, 400);
  }

  return (
    <div className="grid gap-10 md:grid-cols-[1fr_190px]">
      <div className="flex flex-col gap-6">
        {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-600">{error}</p>}

        {!enabled ? (
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-600">
              Enter your email where invoices/bills are received
            </label>
            <input
              type="email"
              value={sourceEmail}
              onChange={(e) => setSourceEmail(e.target.value)}
              placeholder="you@yourbusiness.com"
              data-testid="source-email-input"
              className="w-full max-w-xs rounded border border-zinc-300 px-3 py-2 text-sm"
            />
            <p className="mt-3 max-w-sm rounded-lg bg-zinc-50 p-3 text-xs text-zinc-500">
              Forwarded to a private address only your account can access, used only to detect and remind you about bills.
            </p>
            <label className="mt-2 flex items-center gap-2 text-xs text-zinc-600">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
                data-testid="privacy-acknowledge-checkbox"
              />
              I acknowledge
            </label>
            <button
              onClick={getStarted}
              disabled={starting || !acknowledged || !sourceEmail.trim()}
              data-testid="get-started-button"
              className="mt-3 rounded-lg bg-teal-700 px-4 py-2 text-sm font-medium text-white hover:bg-teal-800 disabled:opacity-50"
            >
              {starting ? "Setting up…" : "Get started"}
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            <div className="flex items-center justify-between">
              <p className="text-sm text-zinc-600">
                On for <span className="font-medium text-zinc-900">{sourceEmail}</span>
              </p>
              <button onClick={turnOff} data-testid="turn-off-button" className="text-xs text-zinc-400 underline hover:text-red-600">
                Turn off
              </button>
            </div>

            {forwardingAddress && (
              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-600">Your forwarding address</label>
                <div className="flex items-center gap-2">
                  <code data-testid="forwarding-address" className="flex-1 truncate rounded border border-zinc-300 bg-zinc-50 px-3 py-2 text-sm">
                    {forwardingAddress}
                  </code>
                  <button
                    data-testid="copy-forwarding-address"
                    onClick={() => {
                      navigator.clipboard.writeText(forwardingAddress);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    }}
                    className="shrink-0 rounded border border-zinc-300 px-3 py-2 text-xs hover:bg-zinc-50"
                  >
                    {copied ? "Copied!" : "Copy"}
                  </button>
                </div>
                <button
                  onClick={() => setShowGmailSteps((v) => !v)}
                  className="mt-2 text-xs text-teal-700 underline"
                >
                  {showGmailSteps ? "Hide" : "How do I add this in Gmail?"}
                </button>
                {showGmailSteps && (
                  <div className="mt-2 rounded-lg bg-zinc-50 p-3 text-xs text-zinc-600">
                    <p className="font-medium text-zinc-700">1. Register the address (one-time)</p>
                    <ol className="mt-1 list-decimal space-y-1 pl-5">
                      <li>Gmail → Settings → Forwarding and POP/IMAP → Add a forwarding address.</li>
                      <li>Paste the address above and confirm it.</li>
                    </ol>
                    <p className="mt-3 font-medium text-zinc-700">2. Forward only bills, not everything</p>
                    <ol className="mt-1 list-decimal space-y-1 pl-5">
                      <li>
                        In Gmail&apos;s search bar, search: <code className="rounded bg-white px-1 py-0.5">subject:(invoice OR bill OR statement OR receipt OR &quot;payment due&quot;)</code>
                      </li>
                      <li>Click the filter icon (⚙ or ▾) at the right of the search bar → &quot;Create filter&quot;.</li>
                      <li>Check &quot;Forward it to&quot;, pick the address above, then &quot;Create filter&quot;.</li>
                    </ol>
                    <p className="mt-2 text-zinc-400">
                      Skip Gmail&apos;s own &quot;forward all mail&quot; option, that sends us everything in your
                      inbox, not just bills.
                    </p>
                  </div>
                )}
              </div>
            )}

            {confirmationLink && !confirmClicked ? (
              <div className="rounded-lg border border-teal-200 bg-teal-50 p-3" data-testid="confirmation-link">
                <p className="mb-2 text-xs text-teal-700">Gmail needs you to confirm this request:</p>
                <a
                  href={confirmationLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setConfirmClicked(true)}
                  className="inline-block rounded-lg bg-teal-700 px-4 py-2 text-sm font-medium text-white hover:bg-teal-800"
                >
                  Confirm forwarding in Gmail →
                </a>
              </div>
            ) : confirmClicked ? (
              <p className="text-sm font-medium text-teal-700" data-testid="already-detecting">
                ✓ Confirmed in Gmail. Forward a bill to test it below.
              </p>
            ) : hasDetectedBill ? (
              <p className="text-sm font-medium text-teal-700" data-testid="already-detecting">
                ✓ Already detecting bills, working whether or not you confirm this in Gmail.
              </p>
            ) : null}

            <div className="rounded-lg bg-zinc-50 p-3 text-xs text-zinc-500">
              We only see mail you forward, starting from when you turn this on. Nothing already in
              your inbox gets scanned. Forward one real bill to the address above to test with real
              content, or use the buttons below to check the plumbing with made-up data.
            </div>

            <div className="flex flex-wrap gap-3">
              <div>
                <button
                  onClick={sendTestBill}
                  disabled={testStatus === "sending"}
                  data-testid="send-test-bill-button"
                  className="rounded border border-teal-300 bg-white px-3 py-2 text-xs font-medium text-teal-700 hover:bg-teal-50 disabled:opacity-50"
                >
                  {testStatus === "sending" ? "Sending…" : "Send a fake test bill"}
                </button>
                {testStatus === "sent" && (
                  <p className="mt-2 text-xs text-teal-700" data-testid="test-bill-sent">
                    ✓ Sent "Sample Utility Co." (not a real bill), check Bills in a few seconds.
                  </p>
                )}
                {testStatus === "error" && <p className="mt-2 text-xs text-red-600">Test send failed. Try again.</p>}
              </div>

              <div>
                <button
                  onClick={sendTestReminder}
                  disabled={reminderTestStatus === "sending" || !hasDetectedBill}
                  data-testid="send-test-reminder-button"
                  className="rounded border border-teal-300 bg-white px-3 py-2 text-xs font-medium text-teal-700 hover:bg-teal-50 disabled:opacity-50"
                >
                  {reminderTestStatus === "sending" ? "Sending…" : "Send a test reminder now"}
                </button>
                {reminderTestStatus === "sent" && (
                  <p className="mt-2 text-xs text-teal-700" data-testid="test-reminder-sent">
                    ✓ Sent via your enabled channels below, for your most recently detected bill.
                  </p>
                )}
                {reminderTestStatus === "error" && (
                  <p className="mt-2 text-xs text-red-600">
                    {hasDetectedBill ? "Test send failed. Try again." : "Detect a bill first."}
                  </p>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-end gap-6 border-t border-zinc-100 pt-5">
              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-600">Remind me (days before due)</label>
                <input
                  type="number"
                  min={0}
                  max={30}
                  value={reminderDaysBefore}
                  data-testid="reminder-days-input"
                  onChange={(e) => {
                    const days = Number(e.target.value);
                    setReminderDaysBefore(days);
                    saveReminderPrefs(days, channels);
                  }}
                  className="w-20 rounded border border-zinc-300 px-3 py-2 text-sm"
                />
              </div>
              <div className="flex gap-3 text-sm">
                {(["push", "email", "in_app"] as const).map((key) => (
                  <label key={key} className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      data-testid={`channel-${key}`}
                      checked={channels[key]}
                      onChange={(e) => {
                        const next = { ...channels, [key]: e.target.checked };
                        setChannels(next);
                        saveReminderPrefs(reminderDaysBefore, next);
                      }}
                    />
                    {key === "in_app" ? "In-app" : key === "push" ? "Push" : "Email"}
                  </label>
                ))}
              </div>
            </div>

            <div data-testid="recently-detected">
              <p className="text-xs font-medium text-zinc-600">Recently detected</p>
              {recentBills.length === 0 ? (
                <p className="mt-1 text-xs text-zinc-400">Nothing yet.</p>
              ) : (
                <div className="mt-2 flex flex-col gap-2">
                  {recentBills.map((b) => (
                    <div
                      key={b.id}
                      className="flex items-center justify-between rounded border border-zinc-200 px-3 py-2 text-xs"
                      data-testid="recently-detected-row"
                    >
                      <div>
                        <p className="font-medium text-zinc-800">{b.vendor_name}</p>
                        <p className="text-zinc-400">
                          {b.due_date ? `Due ${b.due_date}` : "No due date"} · reminder {b.reminder_days_before}d before
                        </p>
                      </div>
                      <span className="rounded-full bg-zinc-100 px-2 py-0.5 font-medium text-zinc-600">{b.status}</span>
                    </div>
                  ))}
                  <Link href="/bills" className="mt-1 text-xs text-teal-700 underline">
                    Review in Bills →
                  </Link>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <aside className="md:border-l md:border-zinc-100 md:pl-6">
        <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-zinc-400">Setup status</p>
        <ul className="flex flex-col gap-2.5">
          <StatusLine done={enabled} active={!enabled} label="Detection turned on" />
          <StatusLine done={!!forwardingAddress} active={enabled && !forwardingAddress} label="Address generated" />
          <StatusLine
            done={hasDetectedBill || confirmClicked || !!confirmationLink}
            active={enabled && !hasDetectedBill && !confirmClicked && !confirmationLink}
            label="Added to Gmail"
          />
          <StatusLine done={hasDetectedBill} active={enabled && !!confirmationLink && !hasDetectedBill} label="First bill detected" />
        </ul>
      </aside>
    </div>
  );
}
