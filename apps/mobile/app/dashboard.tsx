import { useCallback, useState } from "react";
import { View, Text, Pressable, ScrollView, StyleSheet } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { supabase } from "../lib/supabase";
import { colors, spacing, radius, typography, card, cardShadow } from "../lib/theme";

type Stats = {
  outstandingInvoiceTotal: number;
  outstandingInvoiceCount: number;
  unpaidBillTotal: number;
  unpaidBillCount: number;
  pendingReviewCount: number;
  estimateCount: number;
  clientCount: number;
};

const EMPTY_STATS: Stats = {
  outstandingInvoiceTotal: 0,
  outstandingInvoiceCount: 0,
  unpaidBillTotal: 0,
  unpaidBillCount: 0,
  pendingReviewCount: 0,
  estimateCount: 0,
  clientCount: 0,
};

export default function DashboardScreen() {
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);
  const [stats, setStats] = useState<Stats>(EMPTY_STATS);
  const [detectionEnabled, setDetectionEnabled] = useState(false);
  const [sourceEmail, setSourceEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      setLoading(true);
      supabase.auth.getSession().then(({ data }) => {
        if (cancelled) return;
        setEmail(data.session?.user.email ?? null);
        const id = data.session?.user.id ?? null;
        if (!id) return;

        Promise.all([
          supabase.from("invoices").select("id, status, total_cents"),
          supabase.from("bills").select("id, status, total_cents"),
          supabase.from("estimates").select("id"),
          supabase.from("clients").select("id"),
          supabase.from("email_forwarding_addresses").select("enabled, source_email").eq("user_id", id).maybeSingle(),
        ]).then(([invoicesRes, billsRes, estimatesRes, clientsRes, forwardingRes]) => {
          if (cancelled) return;
          const invoices = invoicesRes.data ?? [];
          const bills = billsRes.data ?? [];
          const outstandingInvoices = invoices.filter((i) => i.status === "draft" || i.status === "sent");
          const unpaidBills = bills.filter((b) => b.status === "unpaid");
          setStats({
            outstandingInvoiceTotal: outstandingInvoices.reduce((sum, i) => sum + i.total_cents, 0),
            outstandingInvoiceCount: outstandingInvoices.length,
            unpaidBillTotal: unpaidBills.reduce((sum, b) => sum + b.total_cents, 0),
            unpaidBillCount: unpaidBills.length,
            pendingReviewCount: bills.filter((b) => b.status === "pending_review").length,
            estimateCount: (estimatesRes.data ?? []).length,
            clientCount: (clientsRes.data ?? []).length,
          });
          setDetectionEnabled(forwardingRes.data?.enabled ?? false);
          setSourceEmail(forwardingRes.data?.source_email ?? null);
          setLoading(false);
        });
      });
      return () => {
        cancelled = true;
      };
    }, []),
  );

  const features = [
    {
      href: "/invoices" as const,
      label: "Invoices",
      stat: `${(stats.outstandingInvoiceTotal / 100).toFixed(2)}`,
      sub: `${stats.outstandingInvoiceCount} outstanding`,
      testID: "dashboard-invoices-tile",
    },
    {
      href: "/bills" as const,
      label: "Bills",
      stat: `${(stats.unpaidBillTotal / 100).toFixed(2)}`,
      sub:
        stats.pendingReviewCount > 0
          ? `${stats.unpaidBillCount} unpaid · ${stats.pendingReviewCount} to review`
          : `${stats.unpaidBillCount} unpaid`,
      testID: "dashboard-bills-tile",
    },
    {
      href: "/estimates" as const,
      label: "Estimates",
      stat: `${stats.estimateCount}`,
      sub: "total",
      testID: "dashboard-estimates-tile",
    },
    {
      href: "/clients" as const,
      label: "Clients",
      stat: `${stats.clientCount}`,
      sub: "total",
      testID: "dashboard-clients-tile",
    },
  ];

  return (
    <ScrollView style={styles.container} testID="dashboard-screen">
      <Text style={typography.title}>Dashboard</Text>
      <Text style={styles.signedIn} numberOfLines={1}>
        {email}
      </Text>

      {/* Auto-detect & remind always sits at the very top, on or off. set-and-forget is the
          whole pitch, so its status should be the first thing a returning user sees. */}
      {detectionEnabled ? (
        <Pressable
          style={styles.detectionActiveBanner}
          onPress={() => router.push("/connect-email")}
          testID="email-detection-status-active"
        >
          <View style={styles.detectionIconActive}>
            <Text style={{ fontSize: 16, color: colors.textOnBrand }}>✓</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.detectionTitleActive}>Automatic bill &amp; invoice detection is on</Text>
            <Text style={styles.detectionSubtitleActive}>
              {sourceEmail ? `Connected: ${sourceEmail}. ` : ""}
              {stats.pendingReviewCount > 0
                ? `${stats.pendingReviewCount} new bill${stats.pendingReviewCount === 1 ? "" : "s"} waiting for review.`
                : "You'll be reminded automatically before anything is due."}
            </Text>
          </View>
          <Text style={styles.detectionManageLink}>Manage</Text>
        </Pressable>
      ) : (
        <Pressable style={styles.detectionBanner} onPress={() => router.push("/connect-email")} testID="email-detection-banner">
          <View style={styles.detectionIcon}>
            <Text style={{ fontSize: 16 }}>✉️</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.detectionTitle}>Catch bills from your inbox automatically</Text>
            <Text style={styles.detectionSubtitle}>
              Forward bill emails and we&apos;ll add them here for review. Reminders are on by default.
            </Text>
          </View>
          <View style={styles.detectionButton} testID="enable-email-detection-button">
            <Text style={styles.detectionButtonText}>Set up</Text>
          </View>
        </Pressable>
      )}

      <Text style={styles.sectionLabel}>Create an invoice</Text>
      <View style={styles.createRow}>
        <Pressable
          style={styles.createTile}
          onPress={() => router.push("/invoices/new")}
          testID="create-invoice-manual"
        >
          <Text style={styles.createIcon}>📝</Text>
          <Text style={styles.createLabel}>Manual entry</Text>
        </Pressable>
        <Pressable
          style={styles.createTile}
          onPress={() => router.push({ pathname: "/invoices/new", params: { mode: "scan" } })}
          testID="create-invoice-scan"
        >
          <Text style={styles.createIcon}>📷</Text>
          <Text style={styles.createLabel}>Scan a photo or PDF</Text>
        </Pressable>
        <Pressable
          style={styles.createTile}
          onPress={() => router.push({ pathname: "/invoices/new", params: { mode: "chat" } })}
          testID="create-invoice-chat"
        >
          <Text style={styles.createIcon}>💬</Text>
          <Text style={styles.createLabel}>Chat with AI</Text>
        </Pressable>
      </View>

      {!loading && (
        <View style={styles.grid}>
          {features.map((f) => (
            <Pressable key={f.href} style={styles.tile} onPress={() => router.push(f.href)} testID={f.testID}>
              <Text style={styles.tileLabel}>{f.label}</Text>
              <Text style={styles.tileStat}>{f.stat}</Text>
              <Text style={styles.tileSub}>{f.sub}</Text>
            </Pressable>
          ))}
        </View>
      )}

      <Pressable onPress={() => router.push("/settings")} testID="dashboard-settings-link">
        <Text style={styles.settingsLink}>Business info →</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: spacing.xl },
  signedIn: { fontSize: 12, color: colors.textMuted, marginBottom: spacing.lg },
  detectionBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.brandLight,
    borderWidth: 1,
    borderColor: colors.brandBorder,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  detectionIcon: { width: 32, height: 32, borderRadius: radius.pill, backgroundColor: colors.surface, alignItems: "center", justifyContent: "center" },
  detectionTitle: { fontSize: 13, fontWeight: "700", color: colors.brandDark },
  detectionSubtitle: { fontSize: 11, color: colors.brandDark, marginTop: 2, lineHeight: 15 },
  detectionButton: { backgroundColor: colors.brand, borderRadius: radius.pill, paddingHorizontal: spacing.md, paddingVertical: 8 },
  detectionButtonText: { color: colors.textOnBrand, fontWeight: "700", fontSize: 12 },
  detectionActiveBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.brand,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.lg,
    ...cardShadow,
  },
  detectionIconActive: { width: 32, height: 32, borderRadius: radius.pill, backgroundColor: colors.brand, alignItems: "center", justifyContent: "center" },
  detectionTitleActive: { fontSize: 13, fontWeight: "700", color: colors.textPrimary },
  detectionSubtitleActive: { fontSize: 11, color: colors.textSecondary, marginTop: 2, lineHeight: 15 },
  detectionManageLink: { fontSize: 12, fontWeight: "700", color: colors.brand },
  sectionLabel: { fontSize: 13, fontWeight: "700", color: colors.textPrimary, marginBottom: spacing.sm },
  createRow: { flexDirection: "row", gap: spacing.sm, marginBottom: spacing.lg },
  createTile: { ...card, flex: 1, alignItems: "center", paddingVertical: spacing.md, gap: 4 },
  createIcon: { fontSize: 20 },
  createLabel: { fontSize: 11, fontWeight: "600", color: colors.textSecondary, textAlign: "center" },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.md },
  tile: { ...card, width: "47%", padding: spacing.md },
  tileLabel: { fontSize: 13, fontWeight: "700", color: colors.textPrimary },
  tileStat: { fontSize: 20, fontWeight: "800", color: colors.textPrimary, marginTop: spacing.sm },
  tileSub: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  settingsLink: { color: colors.brand, fontWeight: "600", fontSize: 13, marginTop: spacing.lg, marginBottom: spacing.xxl },
});
