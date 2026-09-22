import { useCallback, useState } from "react";
import { View, Text, FlatList, Pressable, StyleSheet } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { supabase } from "../../lib/supabase";
import type { Database } from "../../lib/database.types";
import { colors, spacing, radius, typography, card, cardShadow } from "../../lib/theme";

type InvoiceRow = Pick<
  Database["public"]["Tables"]["invoices"]["Row"],
  "id" | "invoice_number" | "status" | "total_cents" | "currency"
> & { clients: { name: string } | null };

const STATUS_STYLES: Record<string, { bg: string; fg: string }> = {
  draft: { bg: "#f4f4f5", fg: "#3f3f46" },
  sent: { bg: "#e0f2fe", fg: "#075985" },
  partially_paid: { bg: colors.warningLight, fg: colors.warning },
  paid: { bg: colors.successLight, fg: colors.success },
  void: { bg: "#f4f4f5", fg: colors.textMuted },
};

const NAV_ITEMS = [
  { href: "/dashboard", label: "← Dashboard", testID: "dashboard-link" },
  { href: "/estimates", label: "Estimates", testID: "estimates-link" },
  { href: "/bills", label: "Bills", testID: "bills-link" },
  { href: "/clients", label: "Clients", testID: "clients-link" },
  { href: "/settings", label: "Business info", testID: "settings-link" },
] as const;

export default function InvoicesScreen() {
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [loading, setLoading] = useState(true);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      setLoading(true);
      supabase.auth.getSession().then(({ data }) => {
        if (cancelled) return;
        setEmail(data.session?.user.email ?? null);
      });
      supabase
        .from("invoices")
        .select("id, invoice_number, status, total_cents, currency, clients(name)")
        .order("created_at", { ascending: false })
        .then(({ data }) => {
          if (!cancelled) {
            setInvoices((data as InvoiceRow[]) ?? []);
            setLoading(false);
          }
        });
      return () => {
        cancelled = true;
      };
    }, []),
  );

  const outstanding = invoices.filter((i) => i.status === "draft" || i.status === "sent");
  const outstandingTotal = outstanding.reduce((sum, i) => sum + i.total_cents, 0);
  const sentCount = invoices.filter((i) => i.status !== "draft").length;

  const header = (
    <View>
      <Text style={styles.title}>Invoices</Text>
      <Text style={styles.signedIn} numberOfLines={1} ellipsizeMode="tail">
        {email}
      </Text>

      {/* flexWrap so nav pills drop to a second line on a narrow phone instead of overflowing. */}
      <View style={styles.navRow}>
        {NAV_ITEMS.map((item) => (
          <Pressable key={item.href} style={styles.navPill} onPress={() => router.push(item.href)} testID={item.testID}>
            <Text style={styles.navPillText}>{item.label}</Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.tileRow}>
        <Pressable style={[styles.tile, styles.tileTeal]} onPress={() => router.push("/invoices/new")} testID="create-invoice-tile">
          <View style={styles.tileIconTeal}>
            <Text style={styles.tileIconText}>+</Text>
          </View>
          <Text style={styles.tileTitleTeal}>Create invoice</Text>
          <Text style={styles.tileSubtitleTeal}>Manual, scan, or describe it</Text>
        </Pressable>
        <Pressable style={[styles.tile, styles.tileAmber]} onPress={() => router.push("/invoices/new")}>
          <View style={styles.tileIconAmber}>
            <Text style={styles.tileIconText}>📷</Text>
          </View>
          <Text style={styles.tileTitleAmber}>Scan a photo</Text>
          <Text style={styles.tileSubtitleAmber}>Invoice, receipt, or PO</Text>
        </Pressable>
      </View>

      <View style={styles.statRow}>
        <View style={styles.statCard} testID="stat-outstanding">
          <Text style={styles.statLabel}>Outstanding</Text>
          <Text style={styles.statValue}>{(outstandingTotal / 100).toFixed(2)}</Text>
          <Text style={styles.statSub}>{outstanding.length} invoice{outstanding.length === 1 ? "" : "s"}</Text>
        </View>
        <View style={styles.statCard} testID="stat-sent">
          <Text style={styles.statLabel}>Sent</Text>
          <Text style={styles.statValue}>{sentCount}</Text>
          <Text style={styles.statSub}>of {invoices.length} total</Text>
        </View>
      </View>

      {invoices.length > 0 && <Text style={styles.listHeading}>Recent</Text>}
    </View>
  );

  return (
    <View style={styles.container} testID="invoices-screen">
      {loading ? (
        <>
          {header}
          <Text style={styles.empty}>Loading…</Text>
        </>
      ) : invoices.length === 0 ? (
        <>
          {header}
          <Text style={styles.empty} testID="empty-state">
            No invoices yet.
          </Text>
        </>
      ) : (
        <FlatList
          testID="invoice-list"
          data={invoices}
          keyExtractor={(item) => item.id}
          ListHeaderComponent={header}
          contentContainerStyle={{ paddingBottom: spacing.xxl }}
          renderItem={({ item }) => {
            const statusStyle = STATUS_STYLES[item.status] ?? STATUS_STYLES.draft;
            return (
              <Pressable style={styles.row} testID="invoice-row" onPress={() => router.push(`/invoices/${item.id}`)}>
                <View style={styles.rowLeft}>
                  <Text style={styles.rowName} numberOfLines={1}>{item.clients?.name ?? "Unknown client"}</Text>
                  <Text style={styles.rowNumber}>{item.invoice_number}</Text>
                </View>
                <View style={styles.rowRight}>
                  <Text style={[styles.statusBadge, { backgroundColor: statusStyle.bg, color: statusStyle.fg }]}>
                    {item.status}
                  </Text>
                  <Text style={styles.rowAmount}>
                    {(item.total_cents / 100).toFixed(2)} {item.currency}
                  </Text>
                </View>
              </Pressable>
            );
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: spacing.xl, backgroundColor: colors.background },
  signedIn: { fontSize: 12, color: colors.textMuted, marginBottom: spacing.md },
  title: { ...typography.title, marginBottom: 2 },
  navRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginBottom: spacing.lg },
  navPill: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.pill, paddingHorizontal: spacing.md, paddingVertical: 6 },
  navPillText: { color: colors.brandDark, fontWeight: "600", fontSize: 12 },
  tileRow: { flexDirection: "row", gap: spacing.md, marginBottom: spacing.lg },
  tile: { flex: 1, borderRadius: radius.md, padding: spacing.lg, alignItems: "center", ...cardShadow },
  tileTeal: { backgroundColor: colors.brandLight },
  tileAmber: { backgroundColor: colors.warningLight },
  tileIconTeal: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.brand, alignItems: "center", justifyContent: "center", marginBottom: spacing.sm },
  tileIconAmber: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.warning, alignItems: "center", justifyContent: "center", marginBottom: spacing.sm },
  tileIconText: { color: "#fff", fontSize: 18 },
  tileTitleTeal: { color: colors.brandDark, fontWeight: "700" },
  tileTitleAmber: { color: "#78350f", fontWeight: "700" },
  tileSubtitleTeal: { color: colors.brand, fontSize: 11, marginTop: 2, textAlign: "center" },
  tileSubtitleAmber: { color: colors.warning, fontSize: 11, marginTop: 2, textAlign: "center" },
  statRow: { flexDirection: "row", gap: spacing.md, marginBottom: spacing.lg },
  statCard: { flex: 1, ...card, padding: spacing.md },
  statLabel: { fontSize: 12, color: colors.textSecondary, fontWeight: "600" },
  statValue: { fontSize: 22, fontWeight: "800", marginTop: 2, color: colors.textPrimary },
  statSub: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  listHeading: { ...typography.label, marginBottom: spacing.sm, textTransform: "uppercase", letterSpacing: 0.4 },
  empty: { color: colors.textMuted },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: spacing.sm,
    ...card,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  rowLeft: { flex: 1, flexShrink: 1 },
  rowName: { fontWeight: "700", color: colors.textPrimary, fontSize: 14 },
  rowNumber: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  rowRight: { alignItems: "flex-end", gap: 4, flexShrink: 0 },
  statusBadge: { fontSize: 11, fontWeight: "700", borderRadius: radius.pill, paddingHorizontal: spacing.sm, paddingVertical: 2, overflow: "hidden" },
  rowAmount: { fontWeight: "700", color: colors.textPrimary },
});
