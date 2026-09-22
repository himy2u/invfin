import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { ConnectEmailWizard } from "./connect-email-wizard";

export default async function ConnectEmailPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: profile } = await supabase
    .from("profiles")
    .select("reminder_days_before_default, reminder_channels")
    .eq("user_id", user!.id)
    .maybeSingle();
  const { data: forwardingAddress } = await supabase
    .from("email_forwarding_addresses")
    .select("forwarding_token, enabled, source_email")
    .eq("user_id", user!.id)
    .maybeSingle();

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <Link href="/dashboard" className="mb-6 inline-block text-sm text-teal-700 underline">
        ← Dashboard
      </Link>
      <h1 className="mb-2 text-2xl font-semibold text-zinc-900">Connect your business inbox</h1>
      <p className="mb-8 text-sm text-zinc-500">
        Forward bill emails here and we&apos;ll pull out the vendor, amount, and due date automatically, with a
        reminder before it&apos;s due. You review and approve every one before it counts as a bill.
      </p>
      <ConnectEmailWizard
        userId={user!.id}
        initial={{
          enabled: forwardingAddress?.enabled ?? false,
          forwardingToken: forwardingAddress?.forwarding_token ?? null,
          reminderDaysBefore: profile?.reminder_days_before_default ?? 2,
          channels: (profile?.reminder_channels as { push: boolean; email: boolean; in_app: boolean } | null) ?? {
            push: true,
            email: true,
            in_app: true,
          },
          sourceEmail: forwardingAddress?.source_email ?? null,
        }}
      />
    </main>
  );
}
