import { useEffect, useState } from "react";
import { Platform, View } from "react-native";
import { Stack, useRouter, useSegments } from "expo-router";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";
import { colors } from "../lib/theme";
import { registerForPushNotificationsAsync } from "../lib/push-registration";
import { AppLockGate } from "../components/AppLockGate";

export default function RootLayout() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (session === undefined) return; // still loading
    const inAuthGroup = segments[0] === "login";

    if (!session && !inAuthGroup) {
      router.replace("/login");
    } else if (session && inAuthGroup) {
      router.replace("/dashboard");
    }
  }, [session, segments, router]);

  useEffect(() => {
    if (session) registerForPushNotificationsAsync();
  }, [session]);

  // Without an explicit title per screen, expo-router's Stack falls back to the raw file path
  // ("invoices/index", "invoices/new") as the header text — real header titles, set here once
  // rather than scattered per-file, since most are static.
  const stack = (
    <Stack
      screenOptions={{
        headerShown: true,
        headerStyle: { backgroundColor: colors.surface },
        headerTitleStyle: { color: colors.textPrimary, fontWeight: "700" },
        headerTintColor: colors.brand,
        contentStyle: { backgroundColor: colors.background },
      }}
    >
      <Stack.Screen name="login" options={{ headerShown: false }} />
      <Stack.Screen name="dashboard" options={{ title: "Dashboard" }} />
      <Stack.Screen name="invoices/index" options={{ title: "Invoices" }} />
      <Stack.Screen name="invoices/new" options={{ title: "New invoice" }} />
      <Stack.Screen name="invoices/[id]/edit" options={{ title: "Edit invoice" }} />
      <Stack.Screen name="settings" options={{ title: "Business info" }} />
      <Stack.Screen name="settings/products" options={{ title: "Products and services" }} />
      <Stack.Screen name="connect-email" options={{ title: "Connect email" }} />
      <Stack.Screen name="clients/index" options={{ title: "Clients" }} />
      <Stack.Screen name="estimates/index" options={{ title: "Estimates" }} />
      <Stack.Screen name="estimates/new" options={{ title: "New estimate" }} />
      <Stack.Screen name="clients/[id]" options={{ title: "Client" }} />
      <Stack.Screen name="bills/index" options={{ title: "Bills" }} />
      <Stack.Screen name="bills/new" options={{ title: "New bill" }} />
    </Stack>
  );

  // Only gate screens once a session actually exists — the login screen itself (no session yet)
  // has nothing to protect, and gating it too would just add a pointless Face ID prompt before the
  // user has even entered their email.
  const gatedStack = session ? <AppLockGate>{stack}</AppLockGate> : stack;

  // Real device widths are always phone-narrow, so every screen is styled for that — but the
  // mobile-web dev target renders in an ordinary desktop browser window with no such constraint,
  // so content silently stretched edge-to-edge at 1500px+ wide, reading as a broken 1990s page
  // rather than an app. Capping and centering the content on web only (native is untouched) makes
  // it read as a phone-shaped app floating in the browser, the same convention most responsive
  // web apps use rather than actually reflowing phone-first layouts to fill a desktop window.
  if (Platform.OS === "web") {
    return (
      <View style={{ flex: 1, alignItems: "center", backgroundColor: colors.webSurround }}>
        <View style={{ flex: 1, width: "100%", maxWidth: 480, backgroundColor: colors.background }}>{gatedStack}</View>
      </View>
    );
  }

  return gatedStack;
}
