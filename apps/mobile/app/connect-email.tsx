import { useEffect, useRef, useState } from "react";
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet, Linking } from "react-native";
import { useRouter } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { PendingReviewList, type PendingBill } from "../components/PendingReviewList";
import { supabase } from "../lib/supabase";
import { colors, spacing, radius, typography, card, cardShadow } from "../lib/theme";
import { confirmAsync } from "../lib/confirm";

const FORWARDING_DOMAIN = process.env.EXPO_PUBLIC_EMAIL_FORWARDING_DOMAIN;
const AGENT_SERVICE_URL = process.env.EXPO_PUBLIC_AGENT_SERVICE_URL;
type Channels = { push: boolean; email: boolean; in_app: boolean };

type ChannelKey = "in_app" | "email" | "push";
type ChannelResult = { attempted: boolean; delivered: boolean; reason?: string };
type TestReminderResult = { bill_id: string; channels: Record<ChannelKey, ChannelResult> };

const CHANNEL_LABELS: Record<ChannelKey, string> = { in_app: "In-app", email: "Email", push: "Push" };
const CHANNEL_ORDER: ChannelKey[] = ["in_app", "email", "push"];

// Filled \u25cf = it worked, half \u25d0 = we tried (or would have) and something blocked it, open
// \u25cb = never attempted. Deliberately NOT a green/red traffic light: the bills screen already
// spends amber on "unpaid" and emerald on "paid". Same copy as apps/web's wizard, on purpose.
function channelOutcome(key: ChannelKey, result: ChannelResult): { icon: string; color: string; text: string } {
  if (result.delivered) return { icon: "\u25cf", color: colors.brand, text: "Sent" };

  if (!result.attempted) {
    if (result.reason === "channel_disabled") return { icon: "\u25cb", color: colors.textMuted, text: "Off" };
    return {
      icon: "\u25d0",
      color: colors.warning,
      text:
        key === "push"
          ? "Couldn't reach you here \u2014 no device registered for push"
          : "Couldn't reach you here \u2014 we don't have an email address on your account",
    };
  }

  // Attempted and blocked. The agent service translates Postmark's own error codes into these
  // reasons; a raw code would mean nothing to the person reading this.
  if (result.reason === "sender_pending_approval") {
    return { icon: "\u25d0", color: colors.warning, text: "Couldn't reach you here \u2014 sending is still pending approval" };
  }
  if (result.reason === "sender_not_verified") {
    return { icon: "\u25d0", color: colors.warning, text: "Couldn't reach you here \u2014 your sending email isn't verified yet" };
  }
  return {
    icon: "\u25cf",
    color: colors.danger,
    text: key === "push" ? "Failed to send \u2014 try opening the app on your phone" : "Failed to send",
  };
}

function StatusLine({ done, active, label }: { done: boolean; active?: boolean; label: string }) {
  return (
    <View style={styles.statusLine}>
      <View style={[styles.statusDot, done && styles.statusDotDone, active && styles.statusDotActive]}>
        {done && <Text style={styles.statusDotCheck}>✓</Text>}
      </View>
      <Text style={[styles.statusLabel, done && styles.statusLabelDone, active && styles.statusLabelActive]}>{label}</Text>
    </View>
  );
}

export default function ConnectEmailScreen() {
  const router = useRouter();
  const [userId, setUserId] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [forwardingToken, setForwardingToken] = useState<string | null>(null);
  const [reminderDaysBefore, setReminderDaysBefore] = useState("2");
  const [channels, setChannels] = useState<Channels>({ push: true, email: true, in_app: true });
  const [sourceEmail, setSourceEmail] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirmationLink, setConfirmationLink] = useState<string | null>(null);
  const [confirmClicked, setConfirmClicked] = useState(false);
  const [hasDetectedBill, setHasDetectedBill] = useState(false);
  const [pendingBills, setPendingBills] = useState<PendingBill[]>([]);
  const [starting, setStarting] = useState(false);
  const [reminderTestStatus, setReminderTestStatus] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [testResult, setTestResult] = useState<TestReminderResult | null>(null);
  const [checkStatus, setCheckStatus] = useState<"idle" | "checking" | "done" | "error">("idle");
  const [checkResult, setCheckResult] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [gmailStepsOpen, setGmailStepsOpen] = useState(true);
  // Setup collapses the moment there's anything to review, and is NOT remembered as "expanded
  // once" across loads: the bills list is the reason to come back to this screen, setup is not.
  const [manageOpen, setManageOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveSeq = useRef(0);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      const id = data.session?.user.id ?? null;
      setUserId(id);
      if (!id) return;
      supabase
        .from("profiles")
        .select("reminder_days_before_default, reminder_channels")
        .eq("user_id", id)
        .maybeSingle()
        .then(({ data }) => {
          if (data) {
            setReminderDaysBefore(String(data.reminder_days_before_default ?? 2));
            if (data.reminder_channels) setChannels(data.reminder_channels as Channels);
          }
        });
      supabase
        .from("email_forwarding_addresses")
        .select("forwarding_token, enabled, source_email")
        .eq("user_id", id)
        .maybeSingle()
        .then(({ data }) => {
          if (data) {
            setEnabled(data.enabled);
            setForwardingToken(data.forwarding_token);
            if (data.source_email) setSourceEmail(data.source_email);
          }
        });
    });
  }, []);

  // Polls for Gmail's forwarding-confirmation notification and for any newly detected bill.
  // Confirming in Gmail is for the user's own benefit, not a prerequisite for detection. A live
  // naive-user test found that leaving this unresolved read as "setup failed" to a real user.
  useEffect(() => {
    if (!enabled || !userId) return;
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
        .select("id, vendor_name, total_cents, currency, due_date, status, reminder_days_before")
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
  }, [enabled, confirmationLink, hasDetectedBill, userId]);

  // Collapses the Gmail setup steps the first moment there's real evidence they're no longer
  // needed. A returning user shouldn't have to re-read one-time setup instructions on every visit.
  useEffect(() => {
    if (confirmationLink || confirmClicked || hasDetectedBill) setGmailStepsOpen(false);
  }, [confirmationLink, confirmClicked, hasDetectedBill]);

  async function getStarted() {
    if (!userId) return;
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

  async function openConfirmationLink() {
    if (!confirmationLink) return;
    // Gmail's confirmation page opens outside the app (its own "Success!" screen) with no way for
    // us to be notified when it closes, so this is optimistic. Same reasoning as showing
    // "already detecting" before Gmail's own confirmation ever arrives: the user's own action is
    // the only signal available, and waiting for one that will never come reads as broken.
    setConfirmClicked(true);
    await Linking.openURL(confirmationLink);
  }

  // Runs the real pipeline on demand against this user's own forwarded mail — see the same
  // function in apps/web's wizard. It creates nothing of its own; every count it reports came out
  // of a real email the user actually forwarded.
  async function checkForNewBills() {
    setCheckStatus("checking");
    setCheckResult(null);
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("not signed in");
      const res = await fetch(`${AGENT_SERVICE_URL}/check-new-bills`, {
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
            : "✓ Up to date. Forward a bill, then check again.",
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
      const res = await fetch(`${AGENT_SERVICE_URL}/send-test-reminder`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("test failed");
      // Three channels, three independent outcomes \u2014 never collapsed into one word. The
      // endpoint reports each separately so this can't claim a delivery that didn't happen.
      const body: TestReminderResult = await res.json();
      setTestResult(body);
      setReminderTestStatus("done");
    } catch {
      setReminderTestStatus("error");
    }
  }

  async function turnOff() {
    if (!userId) return;
    const confirmed = await confirmAsync(
      "Turn off automatic bill detection?",
      "Forwarded emails will no longer be scanned.",
    );
    if (!confirmed) return;
    setError(null);
    const { error } = await supabase.from("email_forwarding_addresses").update({ enabled: false }).eq("user_id", userId);
    if (error) {
      setError(error.message);
      return;
    }
    setEnabled(false);
  }

  function saveReminderPrefs(days: string, nextChannels: Channels) {
    if (!userId) return;
    const parsed = Number(days);
    if (Number.isNaN(parsed)) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const mySeq = ++saveSeq.current;
    saveTimer.current = setTimeout(async () => {
      if (mySeq !== saveSeq.current) return;
      const { error } = await supabase
        .from("profiles")
        .upsert(
          { user_id: userId, reminder_days_before_default: parsed, reminder_channels: nextChannels },
          { onConflict: "user_id" },
        );
      if (mySeq !== saveSeq.current) return;
      if (error) setError(error.message);
    }, 400);
  }

  const forwardingAddress = forwardingToken ? `${forwardingToken}@${FORWARDING_DOMAIN}` : null;
  // The three states this screen has: not set up, set up with nothing ever detected, and set up
  // with a review list. Only the last one collapses setup out of the way.
  const setupDone = enabled && hasDetectedBill;
  const enabledChannelLabels = CHANNEL_ORDER.filter((key) => channels[key]).map((key) => CHANNEL_LABELS[key]);
  // A channel a previous test proved can't reach the user stays called out until another test says
  // otherwise — silence about a broken channel is the exact failure this screen exists to stop.
  const unreachable = testResult
    ? CHANNEL_ORDER.filter((key) => {
        const result = testResult.channels[key];
        return result && !result.delivered && result.reason !== "channel_disabled";
      })
    : [];

  // Everything that was this screen before the review list: the forwarding address, the Gmail
  // steps, the Gmail confirmation prompt, reminder defaults, and Turn off. Shown inline while
  // setup is still in progress, and behind "Manage" once there's a bill to review instead.
  const setupPanel = (
    <View>
      {!setupDone && (
        <View style={styles.onRow}>
          <Text style={styles.stepText}>
            On for <Text style={styles.onFor}>{sourceEmail}</Text>
          </Text>
          <Pressable onPress={turnOff} testID="turn-off-button">
            <Text style={styles.turnOffLink}>Turn off</Text>
          </Pressable>
        </View>
      )}

      {forwardingAddress && (
        <View style={{ marginTop: spacing.md }}>
          <Text style={styles.label}>Your forwarding address</Text>
          <View style={styles.addressRow}>
            <Text style={styles.addressText} testID="forwarding-address" numberOfLines={1}>
              {forwardingAddress}
            </Text>
            <Pressable
              testID="copy-forwarding-address"
              onPress={async () => {
                await Clipboard.setStringAsync(forwardingAddress);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
              style={styles.copyButton}
            >
              <Text style={styles.copyButtonText}>{copied ? "Copied!" : "Copy"}</Text>
            </Pressable>
          </View>
          <Pressable onPress={() => setGmailStepsOpen((v) => !v)}>
            <Text style={styles.helpToggle}>{gmailStepsOpen ? "Hide Gmail setup steps" : "Show Gmail setup steps"}</Text>
          </Pressable>
          {gmailStepsOpen && (
            <View style={styles.gmailStepsBox}>
              <Text style={styles.gmailStepsHeading}>1. Register the address (one-time)</Text>
              <Text style={styles.stepListItem}>
                Gmail → Settings → Forwarding and POP/IMAP → Add a forwarding address → paste it → confirm.
              </Text>
              <Text style={styles.gmailStepsHeading}>2. Forward only bills, not everything</Text>
              <Text style={styles.stepListItem}>
                Search: subject:(invoice OR bill OR statement OR receipt) → filter icon → Create filter → check
                &quot;Forward it to&quot; → pick the address → Create filter.
              </Text>
              <Text style={styles.gmailStepsHint}>
                For a bill already in your inbox: forward it manually once, Gmail filters only apply going
                forward.
              </Text>
            </View>
          )}
        </View>
      )}

      {confirmationLink && !confirmClicked ? (
        <View style={styles.codeBox} testID="confirmation-link">
          <Text style={styles.codeLabel}>Gmail needs you to confirm this request:</Text>
          <Pressable style={styles.confirmLinkButton} onPress={openConfirmationLink}>
            <Text style={styles.confirmLinkButtonText}>Confirm forwarding in Gmail →</Text>
          </Pressable>
        </View>
      ) : confirmClicked && !setupDone ? (
        <Text style={styles.alreadyWorkingText} testID="already-detecting">
          ✓ Confirmed in Gmail. Forward a bill to test it.
        </Text>
      ) : null}

      <View style={styles.reminderRow}>
        <View>
          <Text style={styles.label}>Remind me (days before due)</Text>
          <TextInput
            style={[styles.input, { width: 80 }]}
            value={reminderDaysBefore}
            onChangeText={(v) => {
              setReminderDaysBefore(v);
              saveReminderPrefs(v, channels);
            }}
            keyboardType="number-pad"
            testID="reminder-days-input"
          />
        </View>
        <View style={{ flexDirection: "row", gap: spacing.sm, flexWrap: "wrap" }}>
          {(["push", "email", "in_app"] as const).map((key) => (
            <Pressable
              key={key}
              testID={`channel-${key}`}
              onPress={() => {
                const next = { ...channels, [key]: !channels[key] };
                setChannels(next);
                saveReminderPrefs(reminderDaysBefore, next);
              }}
              style={styles.channelChip}
            >
              <Text style={[styles.channelChipText, channels[key] && styles.channelChipTextActive]}>
                {channels[key] ? "✓ " : ""}
                {key === "in_app" ? "In-app" : key === "push" ? "Push" : "Email"}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {setupDone && (
        <Pressable onPress={turnOff} testID="turn-off-button" style={{ marginTop: spacing.md }}>
          <Text style={styles.turnOffLink}>Turn off automatic detection</Text>
        </Pressable>
      )}
    </View>
  );

  const reviewArea = (
    <View style={{ marginTop: spacing.md }}>
      {checkResult && (
        <Text style={styles.testSentText} testID="check-new-bills-result">
          {checkResult}
        </Text>
      )}
      {checkStatus === "error" && <Text style={styles.error}>Check failed, try again</Text>}

      {hasDetectedBill ? (
        <PendingReviewList
          bills={pendingBills}
          variant="table"
          onChanged={(billId) => setPendingBills((prev) => prev.filter((b) => b.id !== billId))}
          heading={
            <Text style={styles.reviewHeading}>
              Bills waiting for your review{pendingBills.length > 0 ? ` (${pendingBills.length})` : ""}
            </Text>
          }
          emptyState={
            <View testID="review-all-caught-up">
              <Text style={styles.reviewHeading}>Bills waiting for your review</Text>
              <Text style={styles.stepHint}>
                You&apos;re all caught up. Nothing new to review right now. Detected bills will show up here.
              </Text>
            </View>
          }
        />
      ) : (
        // Occupies the slot the list will later take, so the screen doesn't jump when the first
        // bill lands.
        <View testID="no-bills-detected-yet">
          <Text style={styles.reviewHeading}>No bills detected yet</Text>
          <Text style={styles.stepHint}>
            Forward or filter a bill to the address above — we&apos;ll pull out the vendor, amount, and due date,
            and it&apos;ll show up here for you to approve.
          </Text>
        </View>
      )}

      <View style={styles.testButtonRow}>
        <Pressable
          style={[styles.testButton, checkStatus === "checking" && styles.buttonDisabled]}
          onPress={checkForNewBills}
          disabled={checkStatus === "checking"}
          testID="check-new-bills-button"
        >
          <Text style={styles.testButtonText}>{checkStatus === "checking" ? "Checking…" : "Check for new bills"}</Text>
        </Pressable>
        <Pressable
          style={[styles.testButton, (reminderTestStatus === "sending" || !hasDetectedBill) && styles.buttonDisabled]}
          onPress={sendTestReminder}
          disabled={reminderTestStatus === "sending" || !hasDetectedBill}
          testID="send-test-reminder-button"
        >
          <Text style={styles.testButtonText}>{reminderTestStatus === "sending" ? "Sending…" : "Send a test reminder"}</Text>
        </Pressable>
      </View>
      {reminderTestStatus === "error" && (
        <Text style={styles.error}>{hasDetectedBill ? "Test failed to run, try again" : "Detect a bill first"}</Text>
      )}

      {testResult && (
        <View style={styles.testResultBox} testID="test-reminder-result">
          <Text style={styles.label}>Test reminder result</Text>
          {CHANNEL_ORDER.map((key) => {
            const result = testResult.channels[key];
            if (!result) return null;
            const outcome = channelOutcome(key, result);
            return (
              <View key={key} style={styles.testResultRow} testID={`test-reminder-channel-${key}`}>
                <Text style={[styles.testResultIcon, { color: outcome.color }]}>{outcome.icon}</Text>
                <Text style={styles.testResultChannel}>{CHANNEL_LABELS[key]}</Text>
                <Text style={[styles.testResultText, { color: outcome.color }]}>{outcome.text}</Text>
              </View>
            );
          })}
        </View>
      )}

      {/* One line per channel, never a combined one: two channels are usually blocked for two
          different reasons, and merging them attaches the first channel's reason to both. */}
      {unreachable.map((key) => (
        <View key={key} style={styles.unreachableBox} testID="channel-unreachable-warning">
          <Text style={styles.unreachableText}>
            ⚠ {CHANNEL_LABELS[key]} reminders can&apos;t reach you yet —{" "}
            {channelOutcome(key, testResult!.channels[key])
              .text.replace("Couldn't reach you here — ", "")
              .replace("Failed to send — ", "")
              .replace("Failed to send", "the send itself failed")}
            . Send another test to re-check.
          </Text>
        </View>
      ))}

      {enabledChannelLabels.length > 0 && (
        <Text style={styles.stepHint} testID="reminder-channels-line">
          Reminders go to: {enabledChannelLabels.join(", ")}
          {testResult ? "" : " — send a test above to check they're reaching you."}
        </Text>
      )}
    </View>
  );

  return (
    <ScrollView style={styles.container} testID="connect-email-screen">
      <Text style={typography.title}>Connect your business inbox</Text>
      {!setupDone && (
        <Text style={styles.intro}>
          Forward bill emails here and we&apos;ll pull out the vendor, amount, and due date automatically.
        </Text>
      )}

      {!setupDone && (
        <View style={styles.statusRow}>
          <StatusLine done={enabled} active={!enabled} label="Detection on" />
          <StatusLine done={!!forwardingAddress} active={enabled && !forwardingAddress} label="Address made" />
          <StatusLine
            done={hasDetectedBill || confirmClicked || !!confirmationLink}
            active={enabled && !hasDetectedBill && !confirmClicked && !confirmationLink}
            label="Added to Gmail"
          />
          <StatusLine done={hasDetectedBill} active={enabled && (confirmClicked || !!confirmationLink) && !hasDetectedBill} label="First bill found" />
        </View>
      )}

      {error && <Text style={styles.error}>{error}</Text>}

      {!enabled ? (
        <View>
          <Text style={styles.label}>Enter your email where invoices/bills are received</Text>
          <TextInput
            style={styles.input}
            value={sourceEmail}
            onChangeText={setSourceEmail}
            placeholder="you@yourbusiness.com"
            keyboardType="email-address"
            autoCapitalize="none"
            testID="source-email-input"
          />
          <Pressable
            style={styles.acknowledgeRow}
            onPress={() => setAcknowledged(!acknowledged)}
            testID="privacy-acknowledge-checkbox"
          >
            <View style={[styles.checkbox, acknowledged && styles.checkboxChecked]}>
              {acknowledged && <Text style={styles.checkboxMark}>✓</Text>}
            </View>
            <Text style={styles.acknowledgeText}>
              I understand this address is private to my account, used only to detect and remind me about bills.
            </Text>
          </Pressable>
          <Pressable
            style={[styles.primaryButton, (starting || !acknowledged || !sourceEmail.trim()) && styles.buttonDisabled]}
            onPress={getStarted}
            disabled={starting || !acknowledged || !sourceEmail.trim()}
            testID="get-started-button"
          >
            <Text style={styles.primaryButtonText}>{starting ? "Setting up…" : "Get started"}</Text>
          </Pressable>
        </View>
      ) : setupDone ? (
        <View>
          <Pressable style={styles.manageRow} onPress={() => setManageOpen((v) => !v)} testID="manage-setup-toggle">
            <Text style={styles.manageSummary} testID="already-detecting">
              <Text style={styles.manageCheck}>✓ </Text>Email detection is on for{" "}
              <Text style={styles.onFor}>{sourceEmail}</Text>
            </Text>
            <Text style={styles.manageChevron}>Manage {manageOpen ? "▴" : "▾"}</Text>
          </Pressable>
          {manageOpen && setupPanel}
          {reviewArea}
        </View>
      ) : (
        <View>
          {setupPanel}
          {reviewArea}
        </View>
      )}

      <View style={styles.footer}>
        <Pressable onPress={() => router.push("/bills")}>
          <Text style={styles.footerLink}>Go to Bills →</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: spacing.xl },
  intro: { ...typography.body, color: colors.textSecondary, marginTop: spacing.xs, marginBottom: spacing.lg },
  error: { color: colors.danger, marginTop: spacing.sm, marginBottom: spacing.md, fontSize: 13 },
  statusRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.md, marginBottom: spacing.lg, paddingBottom: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border },
  statusLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  statusDot: { width: 16, height: 16, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center" },
  statusDotDone: { backgroundColor: colors.brand, borderColor: colors.brand },
  statusDotActive: { borderColor: colors.textPrimary, borderWidth: 2 },
  statusDotCheck: { color: colors.textOnBrand, fontSize: 9, fontWeight: "800" },
  statusLabel: { fontSize: 11, color: colors.textMuted },
  statusLabelDone: { color: colors.brand, fontWeight: "600" },
  statusLabelActive: { color: colors.textPrimary, fontWeight: "600" },
  stepText: { fontSize: 13, color: colors.textSecondary, lineHeight: 18 },
  stepHint: { fontSize: 11, color: colors.textMuted, marginTop: 4, lineHeight: 16 },
  alreadyWorkingText: { fontSize: 13, color: colors.brand, fontWeight: "600", marginTop: spacing.sm },
  stepListItem: { fontSize: 13, color: colors.textSecondary, marginTop: 4, lineHeight: 18 },
  onRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  onFor: { fontWeight: "700", color: colors.textPrimary },
  turnOffLink: { fontSize: 12, color: colors.textMuted, textDecorationLine: "underline" },
  label: { fontSize: 11, color: colors.textMuted, marginTop: spacing.sm, marginBottom: 4, fontWeight: "600" },
  acknowledgeRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs, marginTop: spacing.sm },
  checkbox: { width: 18, height: 18, borderRadius: 4, borderWidth: 1, borderColor: colors.borderStrong, alignItems: "center", justifyContent: "center" },
  checkboxChecked: { backgroundColor: colors.brand, borderColor: colors.brand },
  checkboxMark: { color: colors.textOnBrand, fontSize: 12, fontWeight: "800" },
  acknowledgeText: { fontSize: 12, color: colors.textSecondary },
  input: { ...card, padding: 10, borderRadius: radius.sm, fontSize: 15 },
  primaryButton: { backgroundColor: colors.brand, borderRadius: radius.sm, paddingVertical: 12, paddingHorizontal: spacing.lg, alignItems: "center", marginTop: spacing.sm, alignSelf: "flex-start" },
  buttonDisabled: { opacity: 0.6 },
  primaryButtonText: { color: colors.textOnBrand, fontWeight: "700", fontSize: 14 },
  addressRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginTop: spacing.xs },
  addressText: { flex: 1, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.sm, padding: 10, fontSize: 13, backgroundColor: colors.surfaceAlt },
  copyButton: { borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.sm, paddingHorizontal: spacing.md, paddingVertical: 10 },
  copyButtonText: { fontSize: 12, fontWeight: "600" },
  gmailStepsBox: { backgroundColor: colors.surfaceAlt, borderRadius: radius.sm, padding: spacing.sm, marginTop: spacing.xs },
  gmailStepsHeading: { fontSize: 12, fontWeight: "700", color: colors.textPrimary, marginTop: spacing.sm },
  gmailStepsHint: { fontSize: 11, color: colors.textMuted, marginTop: spacing.sm, lineHeight: 16 },
  codeBox: { marginTop: spacing.md, backgroundColor: colors.brandLight, borderWidth: 1, borderColor: colors.brandBorder, borderRadius: radius.md, padding: spacing.md },
  codeLabel: { fontSize: 11, color: colors.brandDark },
  confirmLinkButton: { marginTop: spacing.sm, backgroundColor: colors.brand, borderRadius: radius.sm, paddingVertical: 10, paddingHorizontal: spacing.md, alignSelf: "flex-start" },
  confirmLinkButtonText: { color: colors.textOnBrand, fontWeight: "700", fontSize: 13 },
  helpToggle: { fontSize: 12, color: colors.brand, textDecorationLine: "underline", marginTop: spacing.xs },
  testButtonRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.md, marginTop: spacing.md },
  testButton: { borderWidth: 1, borderColor: colors.brandBorder, backgroundColor: colors.surface, borderRadius: radius.sm, paddingVertical: 10, paddingHorizontal: spacing.md, alignSelf: "flex-start" },
  testButtonText: { color: colors.brand, fontWeight: "700", fontSize: 13 },
  testSentText: { fontSize: 12, color: colors.brand },
  reminderRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "flex-end", gap: spacing.lg, marginTop: spacing.lg, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border },
  channelChip: { borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.pill, paddingHorizontal: spacing.md, paddingVertical: 6 },
  channelChipText: { fontSize: 12, color: colors.textMuted },
  channelChipTextActive: { color: colors.brand, fontWeight: "600" },
  reviewHeading: { fontSize: 15, fontWeight: "700", color: colors.textPrimary, marginBottom: spacing.xs },
  manageRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm, paddingBottom: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border },
  manageSummary: { flex: 1, fontSize: 13, color: colors.textSecondary, lineHeight: 18 },
  manageCheck: { color: colors.brand, fontWeight: "800" },
  manageChevron: { fontSize: 12, color: colors.textSecondary, fontWeight: "600", borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.sm, paddingHorizontal: spacing.sm, paddingVertical: 6 },
  testResultBox: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, padding: spacing.sm, marginTop: spacing.md },
  testResultRow: { flexDirection: "row", alignItems: "flex-start", gap: 6, marginTop: 4 },
  testResultIcon: { fontSize: 12, lineHeight: 16 },
  testResultChannel: { width: 52, fontSize: 12, fontWeight: "600", color: colors.textSecondary, lineHeight: 16 },
  testResultText: { flex: 1, fontSize: 12, lineHeight: 16 },
  unreachableBox: { backgroundColor: colors.warningLight, borderWidth: 1, borderColor: colors.warningBorder, borderRadius: radius.sm, padding: spacing.sm, marginTop: spacing.sm },
  unreachableText: { fontSize: 12, color: colors.warning, lineHeight: 16 },
  footer: { borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.lg, marginTop: spacing.lg, marginBottom: spacing.xxl },
  footerLink: { color: colors.brand, fontWeight: "600", fontSize: 13 },
});
