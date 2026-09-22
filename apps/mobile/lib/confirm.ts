import { Alert, Platform } from "react-native";

// React Native Web has no real Alert.alert implementation (it's a stub that never invokes the
// button callbacks), so a confirm dialog built only on Alert.alert silently never fires on the
// mobile-web target — the button appears to do nothing. window.confirm is the correct web
// equivalent; native iOS/Android keep the real Alert.alert.
export function confirmAsync(title: string, message: string): Promise<boolean> {
  if (Platform.OS === "web") {
    return Promise.resolve(typeof window !== "undefined" ? window.confirm(`${title}\n\n${message}`) : true);
  }
  return new Promise((resolve) => {
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
      { text: "OK", onPress: () => resolve(true) },
    ]);
  });
}
