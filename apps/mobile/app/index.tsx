import { Redirect } from "expo-router";

// _layout.tsx's auth-state effect further redirects to /invoices if already signed in — this
// just gives expo-router a real route to match at "/" so it doesn't show "Unmatched Route".
export default function Index() {
  return <Redirect href="/login" />;
}
