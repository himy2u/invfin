import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";

// Native has no browser-style "Downloads" — save to cache then hand off to the OS share sheet,
// which lets the user save to Files, print, AirDrop, etc. Mirrors the web app's download button
// closely enough that both platforms feel like the same feature.
export async function saveAndShare(bytes: ArrayBuffer, filename: string, mimeType: string) {
  const file = new File(Paths.cache, filename);
  if (file.exists) file.delete();
  file.create();
  file.write(new Uint8Array(bytes));

  const canShare = await Sharing.isAvailableAsync();
  if (canShare) {
    await Sharing.shareAsync(file.uri, { mimeType });
  }
  return file.uri;
}
