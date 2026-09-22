import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import { supabase } from "./supabase";

// Best-effort only — a user who denies notification permission, or the web dev target (which has
// no native push registration at all), must still be able to use every other part of the app.
// Never throws; every failure path just skips registration silently.
export async function registerForPushNotificationsAsync(): Promise<void> {
  if (Platform.OS === "web") return;

  try {
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
