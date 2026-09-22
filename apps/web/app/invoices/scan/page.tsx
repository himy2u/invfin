import { redirect } from "next/navigation";

// Scanning now lives inside the actual creation form (/invoices/new) so it can feed straight into
// invoice creation — client contact fields and the submit button are right there. This route
// stays only so old links/bookmarks don't 404.
export default function ScanInvoiceRedirect() {
  redirect("/invoices/new");
}
