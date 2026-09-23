import { useEffect, useRef, useState } from "react";
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet, Linking } from "react-native";
import { useRouter } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { supabase } from "../lib/supabase";
import { colors, spacing, radius, typography, card, cardShadow } from "../lib/theme";
import { confirmAsync } from "../lib/confirm";

const FORWARDING_DOMAIN = process.env.EXPO_PUBLIC_EMAIL_FORWARDING_DOMAIN;
const AGENT_SERVICE_URL = process.env.EXPO_PUBLIC_AGENT_SERVICE_URL;
type Channels = { push: boolean; email: boolean; in_app: boolean };

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
  }, [enabled, confirmationLink, hasDetectedBill, userId]);

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

  async function sendTestBill() {
    setTestStatus("sending");
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("not signed in");
      const res = await fetch(`${AGENT_SERVICE_URL}/send-test-bill`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
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
      const res = await fetch(`${AGENT_SERVICE_URL}/send-test-reminder`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      setReminderTestStatus(res.ok ? "sent" : "error");
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

  return (
    <ScrollView style={styles.container} testID="connect-email-screen">
      <Text style={typography.title}>Connect your business inbox</Text>
      <Text style={styles.intro}>
        Forward bill emails here and we&apos;ll pull out the vendor, amount, and due date automatically.
      </Text>

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
          <View style={styles.privacyNote}>
            <Text style={styles.privacyNoteText}>
              Forwarded to a private address only your account can access, used only to detect and remind you about bills.
            </Text>
          </View>
          <Pressable
            style={styles.acknowledgeRow}
            onPress={() => setAcknowledged(!acknowledged)}
            testID="privacy-acknowledge-checkbox"
          >
            <View style={[styles.checkbox, acknowledged && styles.checkboxChecked]}>
              {acknowledged && <Text style={styles.checkboxMark}>✓</Text>}
            </View>
            <Text style={styles.acknowledgeText}>I acknowledge</Text>
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
      ) : (
        <View>
          <View style={styles.onRow}>
            <Text style={styles.stepText}>
              On for <Text style={styles.onFor}>{sourceEmail}</Text>
            </Text>
            <Pressable onPress={turnOff} testID="turn-off-button">
              <Text style={styles.turnOffLink}>Turn off</Text>
            </Pressable>
          </View>

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
              <Pressable onPress={() => setShowGmailSteps((v) => !v)}>
                <Text style={styles.helpToggle}>{showGmailSteps ? "Hide" : "How do I add this in Gmail?"}</Text>
              </Pressable>
              {showGmailSteps && (
                <View style={styles.gmailStepsBox}>
                  <Text style={styles.gmailStepsHeading}>1. Register the address (one-time)</Text>
                  <Text style={styles.stepListItem}>Gmail → Settings → Forwarding and POP/IMAP → Add a forwarding address.</Text>
                  <Text style={styles.stepListItem}>Paste the address above and confirm it.</Text>
                  <Text style={styles.gmailStepsHeading}>2. Forward only bills, not everything</Text>
                  <Text style={styles.stepListItem}>
                    Search Gmail: subject:(invoice OR bill OR statement OR receipt OR &quot;payment due&quot;)
                  </Text>
                  <Text style={styles.stepListItem}>Tap the filter icon at the right of the search bar → &quot;Create filter&quot;.</Text>
                  <Text style={styles.stepListItem}>Check &quot;Forward it to&quot;, pick the address above, then &quot;Create filter&quot;.</Text>
                  <Text style={styles.gmailStepsHint}>
                    Skip Gmail&apos;s own &quot;forward all mail&quot; option, that sends us everything in your
                    inbox, not just bills.
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
          ) : confirmClicked ? (
            <Text style={styles.alreadyWorkingText} testID="already-detecting">
              ✓ Confirmed in Gmail. Forward a bill to test it below.
            </Text>
          ) : hasDetectedBill ? (
            <Text style={styles.alreadyWorkingText} testID="already-detecting">
              ✓ Already detecting bills, working whether or not you confirm this in Gmail.
            </Text>
          ) : null}

          <View style={styles.explainerBox}>
            <Text style={styles.explainerText}>
              We only see mail you forward, starting from when you turn this on. Nothing already in
              your inbox gets scanned. Forward one real bill to the address above to test with real
              content, or use the buttons below to check the plumbing with made-up data.
            </Text>
          </View>

          <View style={styles.testButtonRow}>
            <View>
              <Pressable
                style={[styles.testButton, testStatus === "sending" && styles.buttonDisabled]}
                onPress={sendTestBill}
                disabled={testStatus === "sending"}
                testID="send-test-bill-button"
              >
                <Text style={styles.testButtonText}>{testStatus === "sending" ? "Sending…" : "Send a fake test bill"}</Text>
              </Pressable>
              {testStatus === "sent" && (
                <Text style={styles.testSentText} testID="test-bill-sent">
                  ✓ Sent "Sample Utility Co." (not real), check Bills.
                </Text>
              )}
              {testStatus === "error" && <Text style={styles.error}>Test send failed. Try again.</Text>}
            </View>

            <View>
              <Pressable
                style={[styles.testButton, (reminderTestStatus === "sending" || !hasDetectedBill) && styles.buttonDisabled]}
                onPress={sendTestReminder}
                disabled={reminderTestStatus === "sending" || !hasDetectedBill}
                testID="send-test-reminder-button"
              >
                <Text style={styles.testButtonText}>{reminderTestStatus === "sending" ? "Sending…" : "Send a test reminder now"}</Text>
              </Pressable>
              {reminderTestStatus === "sent" && (
                <Text style={styles.testSentText} testID="test-reminder-sent">
                  ✓ Sent via your channels below.
                </Text>
              )}
              {reminderTestStatus === "error" && (
                <Text style={styles.error}>{hasDetectedBill ? "Test send failed. Try again." : "Detect a bill first."}</Text>
              )}
            </View>
          </View>

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

          <View style={styles.recentSection} testID="recently-detected">
            <Text style={styles.label}>Recently detected</Text>
            {recentBills.length === 0 ? (
              <Text style={styles.stepHint}>Nothing yet.</Text>
            ) : (
              <>
                {recentBills.map((b) => (
                  <View key={b.id} style={styles.recentRow} testID="recently-detected-row">
                    <View style={{ flex: 1 }}>
                      <Text style={styles.recentVendor}>{b.vendor_name}</Text>
                      <Text style={styles.recentMeta}>
                        {b.due_date ? `Due ${b.due_date}` : "No due date"} · reminder {b.reminder_days_before}d before
                      </Text>
                    </View>
                    <Text style={styles.recentStatus}>{b.status}</Text>
                  </View>
                ))}
                <Pressable onPress={() => router.push("/bills")}>
                  <Text style={styles.footerLink}>Review in Bills →</Text>
                </Pressable>
              </>
            )}
          </View>
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
  privacyNote: { backgroundColor: colors.surfaceAlt, borderRadius: radius.sm, padding: spacing.sm, marginTop: spacing.sm },
  privacyNoteText: { fontSize: 11, color: colors.textMuted, lineHeight: 16 },
  acknowledgeRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs, marginTop: spacing.sm },
  checkbox: { width: 18, height: 18, borderRadius: 4, borderWidth: 1, borderColor: colors.borderStrong, alignItems: "center", justifyContent: "center" },
  checkboxChecked: { backgroundColor: colors.brand, borderColor: colors.brand },
  checkboxMark: { color: colors.textOnBrand, fontSize: 12, fontWeight: "800" },
  acknowledgeText: { fontSize: 12, color: colors.textSecondary },
  recentSection: { marginTop: spacing.lg, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border },
  recentRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, padding: spacing.sm, marginTop: spacing.xs },
  recentVendor: { fontSize: 13, fontWeight: "600", color: colors.textPrimary },
  recentMeta: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  recentStatus: { fontSize: 11, fontWeight: "600", color: colors.textMuted, backgroundColor: colors.surfaceAlt, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 3 },
  input: { ...card, padding: 10, borderRadius: radius.sm, fontSize: 15 },
  primaryButton: { backgroundColor: colors.brand, borderRadius: radius.sm, paddingVertical: 12, paddingHorizontal: spacing.lg, alignItems: "center", marginTop: spacing.sm, alignSelf: "flex-start" },
  buttonDisabled: { opacity: 0.6 },
  primaryButtonText: { color: colors.textOnBrand, fontWeight: "700", fontSize: 14 },
  addressRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginTop: spacing.xs },
  addressText: { flex: 1, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.sm, padding: 10, fontSize: 13, backgroundColor: colors.surfaceAlt },
  copyButton: { borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.sm, paddingHorizontal: spacing.md, paddingVertical: 10 },
  copyButtonText: { fontSize: 12, fontWeight: "600" },
  helpToggle: { fontSize: 12, color: colors.brand, textDecorationLine: "underline", marginTop: spacing.xs },
  gmailStepsBox: { backgroundColor: colors.surfaceAlt, borderRadius: radius.sm, padding: spacing.sm, marginTop: spacing.xs },
  gmailStepsHeading: { fontSize: 12, fontWeight: "700", color: colors.textPrimary, marginTop: spacing.sm },
  gmailStepsHint: { fontSize: 11, color: colors.textMuted, marginTop: spacing.sm, lineHeight: 16 },
  codeBox: { marginTop: spacing.md, backgroundColor: colors.brandLight, borderWidth: 1, borderColor: colors.brandBorder, borderRadius: radius.md, padding: spacing.md },
  codeLabel: { fontSize: 11, color: colors.brandDark },
  confirmLinkButton: { marginTop: spacing.sm, backgroundColor: colors.brand, borderRadius: radius.sm, paddingVertical: 10, paddingHorizontal: spacing.md, alignSelf: "flex-start" },
  confirmLinkButtonText: { color: colors.textOnBrand, fontWeight: "700", fontSize: 13 },
  explainerBox: { backgroundColor: colors.surfaceAlt, borderRadius: radius.sm, padding: spacing.sm, marginTop: spacing.md },
  explainerText: { fontSize: 11, color: colors.textMuted, lineHeight: 16 },
  testButtonRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.md, marginTop: spacing.md },
  testButton: { borderWidth: 1, borderColor: colors.brandBorder, backgroundColor: colors.surface, borderRadius: radius.sm, paddingVertical: 10, paddingHorizontal: spacing.md, alignSelf: "flex-start" },
  testButtonText: { color: colors.brand, fontWeight: "700", fontSize: 13 },
  testSentText: { fontSize: 12, color: colors.brand, marginTop: spacing.xs },
  reminderRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "flex-end", gap: spacing.lg, marginTop: spacing.lg, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border },
  channelChip: { borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.pill, paddingHorizontal: spacing.md, paddingVertical: 6 },
  channelChipText: { fontSize: 12, color: colors.textMuted },
  channelChipTextActive: { color: colors.brand, fontWeight: "600" },
  footer: { borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.lg, marginTop: spacing.lg, marginBottom: spacing.xxl },
  footerLink: { color: colors.brand, fontWeight: "600", fontSize: 13 },
});
