import { useEffect, useRef, useState } from "react";
import { AppState, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import * as LocalAuthentication from "expo-local-authentication";
import { colors, radius, spacing, typography } from "../lib/theme";

// Gates access to an already-signed-in session behind Face ID/Touch ID, so a returning user only
// ever enters their email code ONCE — every app open after that unlocks with biometrics instead of
// repeating the OTP flow. Skips itself entirely on web (no biometric APIs there) and on any device
// with no biometric hardware enrolled, so it never blocks access somewhere it can't actually help.
export function AppLockGate({ children }: { children: React.ReactNode }) {
  const [biometricAvailable, setBiometricAvailable] = useState<boolean | null>(null);
  const [unlocked, setUnlocked] = useState(false);
  const [authenticating, setAuthenticating] = useState(false);
  const appState = useRef(AppState.currentState);

  async function checkAvailability() {
    if (Platform.OS === "web") {
      setBiometricAvailable(false);
      return false;
    }
    const hasHardware = await LocalAuthentication.hasHardwareAsync();
    const isEnrolled = await LocalAuthentication.isEnrolledAsync();
    const available = hasHardware && isEnrolled;
    setBiometricAvailable(available);
    return available;
  }

  async function attemptUnlock() {
    setAuthenticating(true);
    try {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: "Unlock invfin",
        cancelLabel: "Cancel",
      });
      if (result.success) setUnlocked(true);
    } finally {
      setAuthenticating(false);
    }
  }

  useEffect(() => {
    checkAvailability().then((available) => {
      if (available) attemptUnlock();
      else setUnlocked(true);
    });
    // Re-lock every time the app returns to the foreground from the background — matches the
    // "every time I open the app" expectation, not just the very first cold start.
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (appState.current.match(/inactive|background/) && nextState === "active" && biometricAvailable) {
        setUnlocked(false);
        attemptUnlock();
      }
      appState.current = nextState;
    });
    return () => subscription.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (biometricAvailable === null || (biometricAvailable && !unlocked)) {
    return (
      <View style={styles.container} testID="app-lock-screen">
        <View style={styles.logoMark}>
          <Text style={styles.logoMarkText}>iF</Text>
        </View>
        <Text style={typography.title}>Unlock invfin</Text>
        <Text style={styles.subtitle}>Use Face ID or Touch ID to continue, no need to re-enter your email code.</Text>
        <Pressable
          style={[styles.unlockButton, authenticating && styles.unlockButtonDisabled]}
          onPress={attemptUnlock}
          disabled={authenticating}
          testID="unlock-button"
        >
          <Text style={styles.unlockButtonText}>{authenticating ? "Checking…" : "Unlock"}</Text>
        </Pressable>
      </View>
    );
  }

  return <>{children}</>;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.md,
    padding: spacing.xl,
  },
  logoMark: {
    width: 56,
    height: 56,
    borderRadius: radius.lg,
    backgroundColor: colors.brand,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.sm,
  },
  logoMarkText: { color: colors.textOnBrand, fontWeight: "800", fontSize: 22 },
  subtitle: { ...typography.body, color: colors.textSecondary, textAlign: "center", maxWidth: 280 },
  unlockButton: {
    marginTop: spacing.md,
    backgroundColor: colors.brand,
    borderRadius: radius.pill,
    paddingVertical: 12,
    paddingHorizontal: spacing.xxl,
  },
  unlockButtonDisabled: { opacity: 0.6 },
  unlockButtonText: { color: colors.textOnBrand, fontWeight: "700", fontSize: 15 },
});
