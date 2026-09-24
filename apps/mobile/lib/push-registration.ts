import { Platform } from "react-native";
import Constants, { ExecutionEnvironment } from "expo-constants";
import { supabase } from "./supabase";

// Best-effort only — a user who denies notification permission, or the web dev target (which has
// no native push registration at all), must still be able to use every other part of the app.
// Never throws; every failure path just skips registration silently.
export async function registerForPushNotificationsAsync(): Promise<void> {
  if (Platform.OS === "web") return;

  // Android remote push was removed from Expo Go entirely as of SDK 53 — merely *importing*
  // expo-notifications throws there (not just calling its functions), which crashed the whole root
  // layout before this function's own guard ever ran, since _layout.tsx statically imports this
  // file. Importing the module dynamically, only after this check, keeps it from ever loading in
  // the one environment where loading it is itself the crash. A real dev build (not Expo Go) never
  // hits this branch and imports normally.
  const isExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;
  if (Platform.OS === "android" && isExpoGo) return;

  try {
    const Notifications = await import("expo-notifications");
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let status = existingStatus;
    if (status !== "granted") {
      const { status: requestedStatus } = await Notifications.requestPermissionsAsync();
      status = requestedStatus;
    }
    if (status !== "granted") return;

    const tokenResponse = await Notifications.getExpoPushTokenAsync();
    const expoPushToken = tokenResponse.data;

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;

    await supabase.from("push_tokens").upsert(
      { user_id: user.id, expo_push_token: expoPushToken },
      { onConflict: "user_id,expo_push_token" },
    );
  } catch {
    // Push registration is a nice-to-have (in-app + email reminders still work) — never let a
    // permissions dialog quirk or a token-fetch failure surface as an app-breaking error.
  }
}
