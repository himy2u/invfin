import { useEffect, useRef, useState } from "react";
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet, Linking } from "react-native";
import { useRouter } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { supabase } from "../lib/supabase";
import { colors, spacing, radius, typography, card, cardShadow } from "../lib/theme";
import { confirmAsync } from "../lib/confirm";

const FORWARDING_DOMAIN = process.env.EXPO_PUBLIC_EMAIL_FORWARDING_DOMAIN;
type Channels = { push: boolean; email: boolean; in_app: boolean };
type StepState = "done" | "active" | "pending";

function StepBubble({ state }: { state: StepState }) {
  return (
    <View
      style={[
        styles.bubble,
        state === "done" && styles.bubbleDone,
        state === "active" && styles.bubbleActive,
        state === "pending" && styles.bubblePending,
      ]}
    >
      {state === "done" && <Text style={styles.bubbleCheck}>✓</Text>}
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
  const [hasDetectedBill, setHasDetectedBill] = useState(false);
  const [recentBills, setRecentBills] = useState<
    { id: string; vendor_name: string; total_cents: number; currency: string; due_date: string | null; status: string; reminder_days_before: number }[]
  >([]);
  const [starting, setStarting] = useState(false);
  const [copied, setCopied] = useState(false);
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

  // Polls for Gmail's forwarding-confirmation notification, which our webhook relays here the
  // moment it arrives. same reasoning as the web wizard: there's no inbox of the user's own to
  // check this code in, since the forwarding address IS the thing being confirmed.
  //
  // Also independently checks whether ANY email-detected bill already exists. The confirmation
  // code is purely for the user's own benefit in Gmail's own dialog, not a prerequisite our
  // system needs to already be detecting bills. without this, a user who forwards a bill before
  // pasting the code back into Gmail sees "waiting for confirmation" forever even after detection
  // has demonstrably worked, which a live naive-user test confirmed reads as "setup failed."
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
    // The forwarding match itself never needed to know which inbox this is FROM (a webhook
    // matches purely on the private token in the recipient address), but a real user has no way
    // to confirm/remember which of their email accounts they pointed at the generated address
    // without this. Required before "Get started" is even enabled.
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
  const step3State: StepState = !enabled ? "pending" : confirmationLink ? "done" : "active";
  const step4State: StepState = !enabled ? "pending" : confirmationLink ? "active" : "pending";

  return (
    <ScrollView style={styles.container} testID="connect-email-screen">
      <Text style={typography.title}>Connect your business inbox</Text>
      <Text style={styles.intro}>
        Forward bill emails here and we&apos;ll pull out the vendor, amount, and due date automatically, with a
        reminder before it&apos;s due. You review and approve every one before it counts as a bill.
      </Text>

      {error && <Text style={styles.error}>{error}</Text>}

      {/* Step 1 */}
      <View style={styles.step}>
        <StepBubble state={enabled ? "done" : "active"} />
        <View style={styles.stepBody}>
          <Text style={styles.stepTitle}>Turn on automatic detection</Text>
          {!enabled ? (
            <>
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
                  Your invoices and bills will be forwarded to a secure, private address that only your
                  account can access, and used only to detect and remind you about them.
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
            </>
          ) : (
            <Text style={styles.stepText}>Detection is on{sourceEmail ? ` for ${sourceEmail}` : ""}.</Text>
          )}
        </View>
      </View>

      {/* Step 2 */}
      <View style={[styles.step, !enabled && styles.stepFaded]}>
        <StepBubble state={enabled ? "done" : "pending"} />
        <View style={styles.stepBody}>
          <Text style={styles.stepTitle}>Copy your forwarding address</Text>
          {forwardingAddress && (
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
          )}
        </View>
      </View>

      {/* Step 3 */}
      <View style={[styles.step, !enabled && styles.stepFaded]}>
        <StepBubble state={enabled ? "done" : "pending"} />
        <View style={styles.stepBody}>
          <Text style={styles.stepTitle}>Add it to your inbox</Text>
          <Text style={styles.stepText}>
            Steps for Gmail (any provider that supports forwarding works the same way, using the address above as
            the forwarding target):
          </Text>
          <Text style={styles.stepListItem}>1. In Gmail, go to Settings → Forwarding and POP/IMAP → Add a forwarding address.</Text>
          <Text style={styles.stepListItem}>2. Paste the address above and confirm. Gmail will email a confirmation code to it.</Text>
        </View>
      </View>

      {/* Step 4 */}
      <View style={[styles.step, !enabled && styles.stepFaded]}>
        <StepBubble state={confirmationLink ? "done" : step3State} />
        <View style={styles.stepBody}>
          <Text style={styles.stepTitle}>Confirm the address</Text>
          {enabled && !confirmationLink && (
            <>
              <Text style={styles.stepText}>Waiting for Gmail&apos;s confirmation email. This usually takes under a minute.</Text>
              {hasDetectedBill ? (
                <Text style={styles.alreadyWorkingText} testID="already-detecting">
                  ✓ We&apos;ve already detected at least one bill. Forwarding is working, even while this step waits.
                </Text>
              ) : (
                <Text style={styles.stepHint}>
                  This step is just for your own reference in Gmail. Detection already works once you&apos;ve added
                  the address above, whether or not this confirmation email ever arrives.
                </Text>
              )}
            </>
          )}
          {confirmationLink && (
            <View style={styles.codeBox} testID="confirmation-link">
              <Text style={styles.codeLabel}>Gmail needs you to confirm this request:</Text>
              <Pressable
                style={styles.confirmLinkButton}
                onPress={() => Linking.openURL(confirmationLink)}
              >
                <Text style={styles.confirmLinkButtonText}>Confirm forwarding in Gmail →</Text>
              </Pressable>
            </View>
          )}
        </View>
      </View>

      {/* Step 5 */}
      <View style={[styles.step, !enabled && styles.stepFaded]}>
        <StepBubble state={step4State === "pending" && confirmationLink ? "done" : "pending"} />
        <View style={styles.stepBody}>
          <Text style={styles.stepTitle}>Set your reminder preferences</Text>
          <Text style={styles.stepText}>
            Once a bill is detected, review it before it counts. You can set how far ahead to be reminded right on
            that review card too.
          </Text>
          <Text style={styles.label}>Remind me (business days before due date)</Text>
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
          <Text style={styles.label}>Notify me via</Text>
          <View style={{ flexDirection: "row", gap: spacing.md }}>
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

          {enabled && (
            <View style={styles.recentSection} testID="recently-detected">
              <Text style={styles.label}>Recently detected</Text>
              {recentBills.length === 0 ? (
                <Text style={styles.stepHint}>
                  None yet. Once a bill or invoice comes in, it&apos;ll show up here with its due date and reminder.
                </Text>
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
                    <Text style={styles.footerLink}>Customize each one in Bills →</Text>
                  </Pressable>
                </>
              )}
            </View>
          )}
        </View>
      </View>

      <View style={styles.footer}>
        <Pressable onPress={() => router.push("/bills")}>
          <Text style={styles.footerLink}>Go to Bills →</Text>
        </Pressable>
        {enabled && (
          <Pressable onPress={turnOff} testID="turn-off-button">
            <Text style={styles.footerTurnOff}>Turn off automatic detection</Text>
          </Pressable>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: spacing.xl },
  intro: { ...typography.body, color: colors.textSecondary, marginTop: spacing.xs, marginBottom: spacing.lg },
  error: { color: colors.danger, marginBottom: spacing.md, fontSize: 13 },
  step: { flexDirection: "row", gap: spacing.md, marginBottom: spacing.lg },
  stepFaded: { opacity: 0.5 },
  stepBody: { flex: 1 },
  stepTitle: { fontSize: 15, fontWeight: "700", color: colors.textPrimary },
  stepText: { fontSize: 13, color: colors.textSecondary, marginTop: 4, lineHeight: 18 },
  stepHint: { fontSize: 11, color: colors.textMuted, marginTop: 4, lineHeight: 16 },
  alreadyWorkingText: { fontSize: 13, color: colors.brand, fontWeight: "600", marginTop: 6 },
  stepListItem: { fontSize: 13, color: colors.textSecondary, marginTop: 4, lineHeight: 18 },
  bubble: { width: 32, height: 32, borderRadius: radius.pill, alignItems: "center", justifyContent: "center" },
  bubbleDone: { backgroundColor: colors.brand },
  bubbleActive: { backgroundColor: colors.brand, ...cardShadow },
  bubblePending: { backgroundColor: colors.border },
  bubbleCheck: { color: colors.textOnBrand, fontWeight: "800", fontSize: 14 },
  label: { fontSize: 11, color: colors.textMuted, marginTop: spacing.sm, marginBottom: 4, fontWeight: "600" },
  privacyNote: { backgroundColor: colors.surfaceAlt, borderRadius: radius.sm, padding: spacing.sm, marginTop: spacing.sm },
  privacyNoteText: { fontSize: 11, color: colors.textMuted, lineHeight: 16 },
  acknowledgeRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs, marginTop: spacing.sm },
  checkbox: { width: 18, height: 18, borderRadius: 4, borderWidth: 1, borderColor: colors.borderStrong, alignItems: "center", justifyContent: "center" },
  checkboxChecked: { backgroundColor: colors.brand, borderColor: colors.brand },
  checkboxMark: { color: colors.textOnBrand, fontSize: 12, fontWeight: "800" },
  acknowledgeText: { fontSize: 12, color: colors.textSecondary },
  recentSection: { marginTop: spacing.md },
  recentRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, padding: spacing.sm, marginTop: spacing.xs },
  recentVendor: { fontSize: 13, fontWeight: "600", color: colors.textPrimary },
  recentMeta: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  recentStatus: { fontSize: 11, fontWeight: "600", color: colors.textMuted, backgroundColor: colors.surfaceAlt, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 3 },
  input: { ...card, padding: 10, borderRadius: radius.sm, fontSize: 15 },
  primaryButton: { backgroundColor: colors.brand, borderRadius: radius.sm, paddingVertical: 12, paddingHorizontal: spacing.lg, alignItems: "center", marginTop: spacing.sm, alignSelf: "flex-start" },
  buttonDisabled: { opacity: 0.6 },
  primaryButtonText: { color: colors.textOnBrand, fontWeight: "700", fontSize: 14 },
  addressRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginTop: spacing.sm },
  addressText: { flex: 1, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.sm, padding: 10, fontSize: 13, backgroundColor: colors.surfaceAlt },
  copyButton: { borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.sm, paddingHorizontal: spacing.md, paddingVertical: 10 },
  copyButtonText: { fontSize: 12, fontWeight: "600" },
  codeBox: { marginTop: spacing.sm, backgroundColor: colors.brandLight, borderWidth: 1, borderColor: colors.brandBorder, borderRadius: radius.md, padding: spacing.md },
  codeLabel: { fontSize: 11, color: colors.brandDark },
  codeValue: { fontSize: 26, fontWeight: "800", color: colors.brandDark, letterSpacing: 2, marginTop: 4 },
  confirmLinkButton: { marginTop: spacing.sm, backgroundColor: colors.brand, borderRadius: radius.sm, paddingVertical: 10, paddingHorizontal: spacing.md, alignSelf: "flex-start" },
  confirmLinkButtonText: { color: colors.textOnBrand, fontWeight: "700", fontSize: 13 },
  channelChip: { borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.pill, paddingHorizontal: spacing.md, paddingVertical: 6, marginTop: spacing.xs },
  channelChipText: { fontSize: 12, color: colors.textMuted },
  channelChipTextActive: { color: colors.brand, fontWeight: "600" },
  footer: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.lg, marginTop: spacing.md, marginBottom: spacing.xxl },
  footerLink: { color: colors.brand, fontWeight: "600", fontSize: 13 },
  footerTurnOff: { color: colors.textMuted, fontSize: 13, textDecorationLine: "underline" },
});
