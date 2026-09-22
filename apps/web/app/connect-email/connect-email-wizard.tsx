"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";

const FORWARDING_DOMAIN = process.env.NEXT_PUBLIC_EMAIL_FORWARDING_DOMAIN;
type Channels = { push: boolean; email: boolean; in_app: boolean };

function StepBubble({ state }: { state: "done" | "active" | "pending" }) {
  const styles = {
    done: "bg-teal-700 text-white",
    active: "bg-teal-700 text-white ring-4 ring-teal-100",
    pending: "bg-zinc-200 text-zinc-500",
  }[state];
  return (
    <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold ${styles}`}>
      {state === "done" ? "✓" : ""}
    </div>
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
  const [confirmationCode, setConfirmationCode] = useState<string | null>(null);
  const [hasDetectedBill, setHasDetectedBill] = useState(false);
  const [recentBills, setRecentBills] = useState<
    { id: string; vendor_name: string; total_cents: number; currency: string; due_date: string | null; status: string; reminder_days_before: number }[]
  >([]);
  const [starting, setStarting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveSeq = useRef(0);

  const forwardingAddress = forwardingToken ? `${forwardingToken}@${FORWARDING_DOMAIN}` : null;

  async function getStarted() {
    // The forwarding match itself never needed to know which inbox this is FROM (a webhook
    // matches purely on the private token in the recipient address. any source inbox works with
    // zero backend change), but a real user setting this up has no way to confirm/remember which
    // of their email accounts they pointed at the generated address without this. Required before
    // "Get started" is even enabled, not an optional afterthought.
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

  async function turnOff() {
    // A real user's biggest fear here is "did that just silently break something I rely on". a
    // plain text link with zero confirmation reads as an accident waiting to happen, same
    // reasoning as this app's other one-way status changes (mark-paid-button.tsx).
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

  // Polls for Gmail's forwarding-confirmation notification, which our webhook relays here the
  // moment it arrives. the user has no inbox of their own to check it in (the forwarding address
  // IS the thing being confirmed), so this page is the only place that code ever surfaces.
  //
  // Also independently checks whether ANY email-detected bill already exists. the confirmation
  // code is purely for the user's own benefit (finishing Gmail's setup dialog), not a prerequisite
  // our system needs to already be detecting bills. Without this, a user who forwards a bill
  // before (or without ever) pasting the code back into Gmail sees "waiting for confirmation"
  // forever even after detection has demonstrably worked. read by a real user as "setup failed,"
  // which a live naive-user test confirmed actually happens.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const poll = async () => {
      if (!confirmationCode) {
        const { data } = await supabase
          .from("notifications")
          .select("body")
          .eq("user_id", userId)
          .eq("type", "gmail_confirmation")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (!cancelled && data) {
          const match = data.body.match(/(\d{6,8})/);
          if (match) setConfirmationCode(match[1]);
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
  }, [enabled, confirmationCode, hasDetectedBill, supabase, userId]);

  function saveReminderPrefs(days: number, nextChannels: Channels) {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const mySeq = ++saveSeq.current;
    saveTimer.current = setTimeout(async () => {
      const { error } = await supabase
        .from("profiles")
        .update({ reminder_days_before_default: days, reminder_channels: nextChannels })
        .eq("user_id", userId);
      if (mySeq !== saveSeq.current) return;
      if (error) setError(error.message);
    }, 400);
  }

  const step2State = !enabled ? "pending" : "done";
  const step3State = !enabled ? "pending" : confirmationCode ? "done" : "active";
  const step4State = !enabled ? "pending" : confirmationCode ? "active" : "pending";

  return (
    <div className="flex flex-col gap-6">
      {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-600">{error}</p>}

      {/* Step 1 */}
      <div className="flex gap-4">
        <StepBubble state={enabled ? "done" : "active"} />
        <div className="flex-1 pb-2">
          <p className="font-semibold text-zinc-900">Turn on automatic detection</p>
          {!enabled ? (
            <>
              <label className="mb-1 mt-1 block text-xs font-medium text-zinc-600">
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
              <p className="mt-3 rounded-lg bg-zinc-50 p-3 text-xs text-zinc-500">
                Your invoices and bills will be forwarded to a secure, private address that only your
                account can access, and used only to detect and remind you about them.
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
            </>
          ) : (
            <p className="mt-1 text-sm text-zinc-500">
              Detection is on{sourceEmail ? ` for ${sourceEmail}` : ""}.
            </p>
          )}
        </div>
      </div>

      {/* Step 2 */}
      <div className="flex gap-4">
        <StepBubble state={step2State} />
        <div className={`flex-1 pb-2 ${!enabled ? "opacity-40" : ""}`}>
          <p className="font-semibold text-zinc-900">Copy your forwarding address</p>
          {forwardingAddress && (
            <div className="mt-2 flex items-center gap-2">
              <code data-testid="forwarding-address" className="flex-1 rounded border border-zinc-300 bg-zinc-50 px-3 py-2 text-sm">
                {forwardingAddress}
              </code>
              <button
                data-testid="copy-forwarding-address"
                onClick={() => {
                  navigator.clipboard.writeText(forwardingAddress);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}
                className="rounded border border-zinc-300 px-3 py-2 text-xs hover:bg-zinc-50"
              >
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Step 3 */}
      <div className="flex gap-4">
        <StepBubble state={step3State} />
        <div className={`flex-1 pb-2 ${!enabled ? "opacity-40" : ""}`}>
          <p className="font-semibold text-zinc-900">Add it to your inbox</p>
          <p className="mt-1 text-sm text-zinc-500">
            Steps for Gmail (any provider that supports forwarding works the same way: use the address above as the
            forwarding target):
          </p>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-zinc-600">
            <li>In Gmail, go to Settings → Forwarding and POP/IMAP → Add a forwarding address.</li>
            <li>Paste the address above and confirm. Gmail will email a confirmation code to it.</li>
          </ol>
        </div>
      </div>

      {/* Step 4 */}
      <div className="flex gap-4">
        <StepBubble state={confirmationCode ? "done" : step4State} />
        <div className={`flex-1 pb-2 ${!enabled ? "opacity-40" : ""}`}>
          <p className="font-semibold text-zinc-900">Confirm the address</p>
          {enabled && !confirmationCode && (
            <>
              <p className="mt-1 flex items-center gap-2 text-sm text-zinc-500">
                <span className="h-2 w-2 animate-pulse rounded-full bg-teal-500" />
                Waiting for Gmail&apos;s confirmation email. This usually takes under a minute.
              </p>
              {/* Confirming is for the user's own benefit (finishing Gmail's own setup dialog) .
                  it's not a prerequisite for us to actually detect bills, so a user who forwards
                  one before ever seeing this code shouldn't be left thinking setup silently
                  failed just because this step never resolves. */}
              {hasDetectedBill ? (
                <p className="mt-2 text-sm font-medium text-teal-700" data-testid="already-detecting">
                  ✓ We&apos;ve already detected at least one bill. Forwarding is working, even while this step waits.
                </p>
              ) : (
                <p className="mt-1 text-xs text-zinc-400">
                  This step is just for your own reference in Gmail. Detection already works once you&apos;ve added
                  the address above, whether or not this code ever arrives.
                </p>
              )}
            </>
          )}
          {confirmationCode && (
            <div className="mt-2 rounded-lg border border-teal-200 bg-teal-50 p-3" data-testid="confirmation-code">
              <p className="text-xs text-teal-700">Enter this code in Gmail to finish confirming:</p>
              <p className="mt-1 font-mono text-2xl font-bold tracking-wider text-teal-900">{confirmationCode}</p>
            </div>
          )}
        </div>
      </div>

      {/* Step 5 */}
      <div className="flex gap-4">
        <StepBubble state={enabled ? (confirmationCode ? "done" : "pending") : "pending"} />
        <div className={`flex-1 pb-2 ${!enabled ? "opacity-40" : ""}`}>
          <p className="font-semibold text-zinc-900">Set your reminder preferences</p>
          <p className="mt-1 text-sm text-zinc-500">
            Once a bill is detected, review it before it counts. You can set how far ahead to be reminded right on
            that review card too.
          </p>
          <div className="mt-3 flex flex-col gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-600">Remind me (business days before due date)</label>
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
                className="w-24 rounded border border-zinc-300 px-3 py-2 text-sm"
              />
            </div>
            <div className="flex gap-4 text-sm">
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

          {enabled && (
            <div className="mt-5" data-testid="recently-detected">
              <p className="text-xs font-medium text-zinc-600">Recently detected</p>
              {recentBills.length === 0 ? (
                <p className="mt-1 text-xs text-zinc-400">
                  None yet. Once a bill or invoice comes in, it&apos;ll show up here with its due date and reminder.
                </p>
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
                    Customize each one in Bills →
                  </Link>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-zinc-100 pt-6">
        <Link href="/bills" className="text-sm text-teal-700 underline">
          Go to Bills →
        </Link>
        {enabled && (
          <button onClick={turnOff} data-testid="turn-off-button" className="text-sm text-zinc-500 underline hover:text-red-600">
            Turn off automatic detection
          </button>
        )}
      </div>
    </div>
  );
}
