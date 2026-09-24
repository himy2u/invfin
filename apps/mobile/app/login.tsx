import { useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet, KeyboardAvoidingView, Platform } from "react-native";
import { supabase } from "../lib/supabase";
import { colors, spacing, radius, typography, card, input as inputStyle, primaryButton, cardShadow } from "../lib/theme";

const AGENT_SERVICE_URL = process.env.EXPO_PUBLIC_AGENT_SERVICE_URL;

export default function LoginScreen() {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [devLoading, setDevLoading] = useState(false);

  // __DEV__ only — lets a tester on the same network skip email OTP delivery entirely (which
  // depends on external mail infra that's unreliable in dev) and see the real account's real data.
  // The endpoint itself doesn't exist on the deployed agent service, so this is a no-op there.
  async function devSkipLogin() {
    setError(null);
    setDevLoading(true);
    try {
      const res = await fetch(`${AGENT_SERVICE_URL}/dev/test-session`, { method: "POST" });
      if (!res.ok) throw new Error(await res.text());
      const { access_token, refresh_token } = await res.json();
      const { error } = await supabase.auth.setSession({ access_token, refresh_token });
      if (error) setError(error.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : "dev login failed");
    } finally {
      setDevLoading(false);
    }
  }

  async function sendCode() {
    setError(null);
    setLoading(true);
    // No emailRedirectTo: without it, GoTrue sends a plain 6-digit code instead of a PKCE link —
    // clicking a link from an email client can't reliably deep-link back into Expo Go.
    const { error } = await supabase.auth.signInWithOtp({ email });
    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    setStep("code");
  }

  async function verifyCode() {
    setError(null);
    setLoading(true);
    const { error } = await supabase.auth.verifyOtp({ email, token: code, type: "email" });
    setLoading(false);
    if (error) setError(error.message);
    // On success, _layout.tsx's onAuthStateChange listener handles the redirect.
  }

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      testID="login-screen"
    >
      <View style={styles.content}>
        <View style={styles.brandRow}>
          <View style={styles.logoMark}>
            <Text style={styles.logoMarkText}>iF</Text>
          </View>
          <Text style={styles.brandName}>invfin</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.title}>{step === "email" ? "Welcome back" : "Check your email"}</Text>
          <Text style={styles.subtitle}>
            {step === "email"
              ? "Enter your email and we'll send you a one-time code, no password to remember."
              : `We sent a 6-digit code to ${email}`}
          </Text>

          {step === "email" ? (
            <>
              <Text style={styles.fieldLabel}>Email</Text>
              <TextInput
                style={styles.input}
                placeholder="you@business.com"
                placeholderTextColor={colors.textMuted}
                value={email}
                onChangeText={setEmail}
                autoCapitalize="none"
                keyboardType="email-address"
                testID="email-input"
              />
              <Pressable
                style={[styles.button, (loading || !email.trim()) && styles.buttonDisabled]}
                onPress={sendCode}
                disabled={loading || !email.trim()}
                testID="send-code-button"
              >
                <Text style={styles.buttonText}>{loading ? "Sending…" : "Send code"}</Text>
              </Pressable>

              {__DEV__ && (
                <Pressable
                  style={styles.linkRow}
                  onPress={devSkipLogin}
                  disabled={devLoading}
                  testID="dev-skip-login-button"
                >
                  <Text style={styles.link}>
                    {devLoading ? "Signing in…" : "Skip login (test mode, dev only)"}
                  </Text>
                </Pressable>
              )}
            </>
          ) : (
            <>
              <Text style={styles.fieldLabel}>6-digit code</Text>
              <TextInput
                style={[styles.input, styles.codeInput]}
                placeholder="000000"
                placeholderTextColor={colors.textMuted}
                value={code}
                onChangeText={setCode}
                keyboardType="number-pad"
                testID="code-input"
              />
              <Pressable
                style={[styles.button, (loading || !code.trim()) && styles.buttonDisabled]}
                onPress={verifyCode}
                disabled={loading || !code.trim()}
                testID="verify-code-button"
              >
                <Text style={styles.buttonText}>{loading ? "Verifying…" : "Verify"}</Text>
              </Pressable>

              <View style={styles.linkRow}>
                <Pressable onPress={sendCode} disabled={loading} testID="resend-code-button">
                  <Text style={styles.link}>Resend code</Text>
                </Pressable>
                <Text style={styles.linkDivider}>·</Text>
                <Pressable
                  onPress={() => {
                    setStep("email");
                    setCode("");
                    setError(null);
                  }}
                  testID="change-email-button"
                >
                  <Text style={styles.link}>Use a different email</Text>
                </Pressable>
              </View>
            </>
          )}

          {error && (
            <View style={styles.errorBox}>
              <Text style={styles.error} testID="login-error">
                {error}
              </Text>
            </View>
          )}
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background, justifyContent: "center" },
  content: { paddingHorizontal: spacing.xl },
  brandRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.sm, marginBottom: spacing.xxl },
  logoMark: { width: 36, height: 36, borderRadius: radius.sm, backgroundColor: colors.brand, alignItems: "center", justifyContent: "center" },
  logoMarkText: { color: colors.textOnBrand, fontWeight: "800", fontSize: 15 },
  brandName: { fontSize: 20, fontWeight: "800", color: colors.textPrimary, letterSpacing: -0.3 },
  card: { ...card, padding: spacing.xl },
  title: { ...typography.title, marginBottom: spacing.xs },
  subtitle: { fontSize: 14, color: colors.textSecondary, lineHeight: 20, marginBottom: spacing.lg },
  fieldLabel: { ...typography.label, marginBottom: spacing.xs },
  input: { ...inputStyle, marginBottom: spacing.lg },
  codeInput: { fontSize: 20, letterSpacing: 6, textAlign: "center", fontWeight: "700" },
  button: { ...primaryButton },
  buttonDisabled: { opacity: 0.5, ...cardShadow, shadowOpacity: 0 },
  buttonText: { color: colors.textOnBrand, fontWeight: "700", fontSize: 15 },
  linkRow: { flexDirection: "row", justifyContent: "center", alignItems: "center", gap: spacing.sm, marginTop: spacing.lg, flexWrap: "wrap" },
  link: { color: colors.brand, fontWeight: "600", fontSize: 13 },
  linkDivider: { color: colors.textMuted, fontSize: 13 },
  errorBox: { backgroundColor: colors.dangerLight, borderRadius: radius.sm, padding: spacing.md, marginTop: spacing.lg },
  error: { color: colors.danger, fontSize: 13, fontWeight: "500" },
});
