import { Redirect } from "expo-router";

// Scanning now lives inside the actual creation screen (/invoices/new) so it can feed straight
// into invoice creation — client contact fields and the submit button are right there.
export default function ScanInvoiceRedirect() {
  return <Redirect href="/invoices/new" />;
}
