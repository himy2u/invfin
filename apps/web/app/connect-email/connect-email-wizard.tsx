"use client";

import { useEffect, useRef, useState } from "react";
import { PendingReviewSection } from "@/app/bills/pending-review-section";
import { createClient } from "@/lib/supabase/client";

const FORWARDING_DOMAIN = process.env.NEXT_PUBLIC_EMAIL_FORWARDING_DOMAIN;
type Channels = { push: boolean; email: boolean; in_app: boolean };

type ChannelKey = "in_app" | "email" | "push";
type ChannelResult = { attempted: boolean; delivered: boolean; reason?: string };
type TestReminderResult = { bill_id: string; channels: Record<ChannelKey, ChannelResult> };

const CHANNEL_LABELS: Record<ChannelKey, string> = { in_app: "In-app", email: "Email", push: "Push" };
const CHANNEL_ORDER: ChannelKey[] = ["in_app", "email", "push"];

// Filled ● = it worked, half ◐ = we tried (or would have) and something blocked it, open ○ = never
// attempted. Deliberately NOT a green/red traffic light: /bills already spends amber on
// "unpaid" and emerald on "paid", and a second, unrelated meaning for the same two colors on an
// adjacent screen is how a user learns to misread both.
function channelOutcome(key: ChannelKey, result: ChannelResult): { icon: string; className: string; text: string } {
  if (result.delivered) return { icon: "●", className: "text-teal-700", text: "Sent" };

  if (!result.attempted) {
    if (result.reason === "channel_disabled") {
      return { icon: "○", className: "text-zinc-400", text: "Off" };
    }
    return {
      icon: "◐",
      className: "text-amber-700",
      text:
        key === "push"
          ? "Couldn't reach you here — no device registered for push"
          : "Couldn't reach you here — we don't have an email address on your account",
    };
  }

  // Attempted and blocked. Postmark's own error codes are translated into plain reasons by the
  // agent service; a raw code or its raw message would mean nothing to the person reading this.
  if (result.reason === "sender_pending_approval") {
    return { icon: "◐", className: "text-amber-700", text: "Couldn't reach you here — sending is still pending approval" };
  }
  if (result.reason === "sender_not_verified") {
    return { icon: "◐", className: "text-amber-700", text: "Couldn't reach you here — your sending email isn't verified yet" };
  }
  return {
    icon: "●",
    className: "text-red-600",
    text: key === "push" ? "Failed to send — try opening the app on your phone" : "Failed to send",
  };
}

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
  const [pendingBills, setPendingBills] = useState<
    { id: string; vendor_name: string; total_cents: number; currency: string; due_date: string | null; reminder_mode: string; reminder_offset_value: number; reminder_offset_unit: string; reminder_at: string | null }[]
  >([]);
  const [starting, setStarting] = useState(false);
  const [reminderTestStatus, setReminderTestStatus] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [testResult, setTestResult] = useState<TestReminderResult | null>(null);
  const [checkStatus, setCheckStatus] = useState<"idle" | "checking" | "done" | "error">("idle");
  const [checkResult, setCheckResult] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [gmailStepsOpen, setGmailStepsOpen] = useState(true);
  // Setup collapses the moment there's anything to review, and is NOT remembered as "expanded once"
  // across loads: the bills table is the reason to come back to this page, setup is not.
  const [manageOpen, setManageOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveSeq = useRef(0);

  const forwardingAddress = forwardingToken ? `${forwardingToken}@${FORWARDING_DOMAIN}` : null;
  // The three states the page has: not set up, set up with nothing ever detected, and set up with
  // a review queue. Only the last one collapses setup out of the way.
  const setupDone = enabled && hasDetectedBill;

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

  // Runs the real pipeline on demand against this user's own forwarded mail: anything sitting in
  // the inbound queue that the automatic path hasn't finished gets classified and extracted now.
  // It creates nothing of its own, so every count it reports — and every bill that then appears in
  // the table above — came out of a real email the user actually forwarded.
  async function checkForNewBills() {
    setCheckStatus("checking");
    setCheckResult(null);
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("not signed in");
      const res = await fetch(`${process.env.NEXT_PUBLIC_AGENT_SERVICE_URL}/check-new-bills`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("check failed");
      const body: { checked: number; bills_detected: number } = await res.json();
      setCheckStatus("done");
      setCheckResult(
        body.bills_detected > 0
          ? `✓ Found ${body.bills_detected} new bill${body.bills_detected === 1 ? "" : "s"}`
          : body.checked > 0
            ? "✓ Checked — nothing new to add"
            : "✓ Up to date. Forward a bill to your forwarding address, then check again.",
      );
    } catch {
      setCheckStatus("error");
    }
  }

  async function sendTestReminder() {
    setReminderTestStatus("sending");
    setTestResult(null);
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("not signed in");
      const res = await fetch(`${process.env.NEXT_PUBLIC_AGENT_SERVICE_URL}/send-test-reminder`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("test failed");
      // Three channels, three independent outcomes — never collapsed into one word. The endpoint
      // reports each one separately precisely so this can't claim a delivery that didn't happen.
      const body: TestReminderResult = await res.json();
      setTestResult(body);
      setReminderTestStatus("done");
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

  // Polls for Gmail's forwarding-confirmation notification and for this user's detected bills.
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
      // Every status, not just pending_review: "has anything ever been detected" is what decides
      // whether setup collapses, and an already-approved bill still answers that yes.
      const { data: bills } = await supabase
        .from("bills")
        .select("id, vendor_name, total_cents, currency, due_date, status, reminder_mode, reminder_offset_value, reminder_offset_unit, reminder_at")
        .eq("source", "email")
        .order("created_at", { ascending: false })
        .limit(50);
      if (!cancelled && bills) {
        setPendingBills(bills.filter((b) => b.status === "pending_review"));
        if (bills.length > 0) setHasDetectedBill(true);
      }
    };
    poll();
    const interval = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [enabled, confirmationLink, supabase, userId]);

  // Collapses the Gmail setup steps the first moment there's real evidence they're no longer
  // needed (a confirmation link arrived, was clicked, or a bill was detected). A returning user
  // shouldn't have to re-read one-time setup instructions on every visit. Still user-toggleable.
  useEffect(() => {
    if (confirmationLink || confirmClicked || hasDetectedBill) setGmailStepsOpen(false);
  }, [confirmationLink, confirmClicked, hasDetectedBill]);

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

  // Everything that was the page before the review table: the forwarding address, the Gmail steps,
  // the Gmail confirmation prompt, reminder defaults, and Turn off. Shown inline while setup is
  // still in progress, and tucked behind "Manage" once there's a bill to review instead.
  const setupPanel = (
    <div className="flex flex-col gap-5">
      {!setupDone && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-zinc-600">
            On for <span className="font-medium text-zinc-900">{sourceEmail}</span>
          </p>
          <button onClick={turnOff} data-testid="turn-off-button" className="text-xs text-zinc-400 underline hover:text-red-600">
            Turn off
          </button>
        </div>
      )}

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
          <button onClick={() => setGmailStepsOpen((v) => !v)} className="mt-2 text-xs text-teal-700 underline">
            {gmailStepsOpen ? "Hide Gmail setup steps" : "Show Gmail setup steps"}
          </button>
          {gmailStepsOpen && (
            <div className="mt-2 rounded-lg bg-zinc-50 p-3 text-xs text-zinc-600">
              <p className="font-medium text-zinc-700">1. Register the address (one-time)</p>
              <p className="mt-1">Gmail → Settings → Forwarding and POP/IMAP → Add a forwarding address → paste it → confirm.</p>
              <p className="mt-3 font-medium text-zinc-700">2. Forward only bills, not everything</p>
              <p className="mt-1">
                Search: <code className="rounded bg-white px-1 py-0.5">subject:(invoice OR bill OR statement OR receipt)</code>
                {" "}→ filter icon → Create filter → check &quot;Forward it to&quot; → pick the address → Create filter.
              </p>
              <p className="mt-2 text-zinc-400">
                For a bill already in your inbox: forward it manually once, Gmail filters only apply going forward.
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
      ) : confirmClicked && !setupDone ? (
        <p className="text-sm font-medium text-teal-700" data-testid="already-detecting">
          ✓ Confirmed in Gmail. Forward a bill to test it.
        </p>
      ) : null}

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

      {setupDone && (
        <div>
          <button onClick={turnOff} data-testid="turn-off-button" className="text-xs text-zinc-400 underline hover:text-red-600">
            Turn off automatic detection
          </button>
        </div>
      )}
    </div>
  );

  const enabledChannelLabels = CHANNEL_ORDER.filter((key) => channels[key]).map((key) => CHANNEL_LABELS[key]);
  // A channel that a previous test proved can't reach the user stays called out until another test
  // says otherwise — silence about a broken channel is exactly the failure mode this page exists
  // to stop reproducing.
  const unreachable = testResult
    ? CHANNEL_ORDER.filter((key) => {
        const result = testResult.channels[key];
        return result && !result.delivered && result.reason !== "channel_disabled";
      })
    : [];

  const reviewArea = (
    <div className="flex flex-col gap-4">
      {checkResult && (
        <p className="text-xs text-teal-700" data-testid="check-new-bills-result">
          {checkResult}
        </p>
      )}
      {checkStatus === "error" && <p className="text-xs text-red-600">Check failed, try again</p>}

      {hasDetectedBill ? (
        <PendingReviewSection
          bills={pendingBills}
          variant="table"
          onChanged={(billId) => setPendingBills((prev) => prev.filter((b) => b.id !== billId))}
          heading={
            <h2 className="mb-2 text-base font-semibold text-zinc-900">
              Bills waiting for your review{pendingBills.length > 0 ? ` (${pendingBills.length})` : ""}
            </h2>
          }
          emptyState={
            <div className="mb-4" data-testid="review-all-caught-up">
              <h2 className="mb-1 text-base font-semibold text-zinc-900">Bills waiting for your review</h2>
              <p className="text-sm text-zinc-500">
                <span className="font-medium text-zinc-700">You&apos;re all caught up.</span> Nothing new to review right
                now. Detected bills will show up here.
              </p>
            </div>
          }
        />
      ) : (
        // Occupies the slot the table will later take, so the page doesn't jump when the first
        // bill lands.
        <div className="mb-4" data-testid="no-bills-detected-yet">
          <h2 className="mb-1 text-base font-semibold text-zinc-900">No bills detected yet</h2>
          <p className="text-sm text-zinc-500">
            Forward or filter a bill to the address above — we&apos;ll pull out the vendor, amount, and due date, and
            it&apos;ll show up here for you to approve.
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={checkForNewBills}
          disabled={checkStatus === "checking"}
          data-testid="check-new-bills-button"
          className="rounded border border-zinc-300 bg-white px-3 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
        >
          {checkStatus === "checking" ? "Checking…" : "Check for new bills"}
        </button>
        <button
          onClick={sendTestReminder}
          disabled={reminderTestStatus === "sending" || !hasDetectedBill}
          data-testid="send-test-reminder-button"
          title={hasDetectedBill ? undefined : "Detect a bill first"}
          className="rounded border border-zinc-300 bg-white px-3 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
        >
          {reminderTestStatus === "sending" ? "Sending…" : "Send a test reminder"}
        </button>
        {reminderTestStatus === "error" && <span className="text-xs text-red-600">Test failed to run, try again</span>}
      </div>

      {testResult && (
        <div className="rounded-lg border border-zinc-200 p-3" data-testid="test-reminder-result">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">Test reminder result</p>
          <ul className="flex flex-col gap-1">
            {CHANNEL_ORDER.map((key) => {
              const result = testResult.channels[key];
              if (!result) return null;
              const outcome = channelOutcome(key, result);
              return (
                <li key={key} className="flex items-start gap-2 text-xs" data-testid={`test-reminder-channel-${key}`}>
                  <span className={outcome.className}>{outcome.icon}</span>
                  <span className="w-14 shrink-0 font-medium text-zinc-700">{CHANNEL_LABELS[key]}</span>
                  <span className={outcome.className}>{outcome.text}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* One line per channel, never a combined one: two channels are usually blocked for two
          different reasons, and merging them attaches the first channel's reason to both — which
          is its own small lie about what happened. */}
      {unreachable.map((key) => (
        <p key={key} className="text-xs text-amber-700" data-testid="channel-unreachable-warning">
          ⚠ {CHANNEL_LABELS[key]} reminders can&apos;t reach you yet —{" "}
          {channelOutcome(key, testResult!.channels[key])
            .text.replace("Couldn't reach you here — ", "")
            .replace("Failed to send — ", "")
            .replace("Failed to send", "the send itself failed")}
          . Send another test to re-check.
        </p>
      ))}

      {enabledChannelLabels.length > 0 && (
        <p className="text-xs text-zinc-500" data-testid="reminder-channels-line">
          Reminders go to: <span className="font-medium text-zinc-700">{enabledChannelLabels.join(", ")}</span>
          {testResult ? "" : " — send a test above to check they're reaching you."}
        </p>
      )}
    </div>
  );

  if (setupDone) {
    return (
      <div className="flex flex-col gap-6">
        {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-600">{error}</p>}

        <div className="border-b border-zinc-200 pb-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-zinc-700" data-testid="already-detecting">
              <span className="font-semibold text-teal-700">✓</span> Email detection is on for{" "}
              <span className="font-medium text-zinc-900">{sourceEmail}</span>
            </p>
            <button
              onClick={() => setManageOpen((v) => !v)}
              data-testid="manage-setup-toggle"
              className="shrink-0 rounded border border-zinc-300 px-3 py-1.5 text-xs text-zinc-600 hover:bg-zinc-50"
            >
              Manage {manageOpen ? "▴" : "▾"}
            </button>
          </div>
          {manageOpen && <div className="mt-4">{setupPanel}</div>}
        </div>

        {reviewArea}
      </div>
    );
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
            <label className="mt-3 flex items-start gap-2 text-xs text-zinc-600">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
                data-testid="privacy-acknowledge-checkbox"
                className="mt-0.5"
              />
              I understand this address is private to my account, used only to detect and remind me about bills.
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
          <>
            {setupPanel}
            {reviewArea}
          </>
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
