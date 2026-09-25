import { useCallback, useState } from "react";
import { View, Text, FlatList, Pressable, StyleSheet } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { PendingReviewList } from "../../components/PendingReviewList";
import { supabase } from "../../lib/supabase";
import { formatMoney } from "../../lib/money";

type BillRow = {
  id: string;
  duplicate_of_bill_id: string | null;
  bill_number: string;
  status: string;
  total_cents: number;
  currency: string;
  vendor_name: string;
  due_date: string | null;
  reminder_mode: string;
  reminder_offset_value: number;
  reminder_offset_unit: string;
  reminder_at: string | null;
};

const STATUS_STYLES: Record<string, { bg: string; fg: string }> = {
  unpaid: { bg: "#fef3c7", fg: "#92400e" },
  paid: { bg: "#d1fae5", fg: "#065f46" },
};

// Same two hues STATUS_STYLES already spends, plus red as the one escalation this screen doesn't
// otherwise use. Kept in step with apps/web/app/bills/page.tsx so the same bill reads the same way on
// both platforms.
const URGENCY_STYLES = {
  overdue: { bg: "#fee2e2", fg: "#991b1b" },
  soon: { bg: "#fef3c7", fg: "#92400e" },
} as const;

const DUE_SOON_DAYS = 7;

/** How urgent an unpaid bill's due date is, as of today, or null when there's nothing to be urgent
 * about. Compared as plain calendar dates at UTC midnight: a bill is due ON a date, not at an instant,
 * and mixing a date-only value with a local-time now makes "due today" flip to "overdue" west of UTC. */
function urgency(dueDate: string | null, status: string): { label: string; style: { bg: string; fg: string } } | null {
  if (!dueDate || status !== "unpaid") return null;
  const due = Date.parse(`${dueDate}T00:00:00Z`);
  if (Number.isNaN(due)) return null;
  const now = new Date();
  const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days = Math.round((due - startOfToday) / 86400000);
  if (days < 0) return { label: days === -1 ? "Overdue by 1 day" : `Overdue by ${-days} days`, style: URGENCY_STYLES.overdue };
  if (days === 0) return { label: "Due today", style: URGENCY_STYLES.overdue };
  if (days <= DUE_SOON_DAYS) {
    return { label: days === 1 ? "Due tomorrow" : `Due in ${days} days`, style: URGENCY_STYLES.soon };
  }
  return null;
}

export default function BillsScreen() {
  const router = useRouter();
  const [bills, setBills] = useState<BillRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    supabase
      .from("bills")
      .select(
        "id, bill_number, status, total_cents, currency, vendor_name, due_date, reminder_mode, reminder_offset_value, reminder_offset_unit, reminder_at, duplicate_of_bill_id",
      )
      // Soonest due first, bills with no due date last. Matches the web list: "what do I have to pay
      // next" is the only question this screen answers, and created_at ordering answered a different one.
      .order("due_date", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: false })
      .then(({ data }) => {
        if (!cancelled) {
          const rows = (data as BillRow[]) ?? [];
          setBills(rows);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useFocusEffect(load);

  // pending_review/dismissed are excluded from both the visible list and the unpaid total by
  // filtering on the literal statuses. see the migration comment on why review state reuses
  // bill_status instead of a parallel column: an unconfirmed, AI-guessed bill must never count
  // toward "what you owe."
  const numberById = new Map(bills.map((b) => [b.id, b.bill_number]));
  const pendingReview = bills
    .filter((b) => b.status === "pending_review")
    .map((b) => ({
      ...b,
      duplicate_of_bill_number: b.duplicate_of_bill_id ? (numberById.get(b.duplicate_of_bill_id) ?? null) : null,
    }));
  const visibleBills = bills.filter((b) => b.status !== "pending_review" && b.status !== "dismissed");
  const unpaid = bills.filter((b) => b.status === "unpaid");
  // One line per currency rather than a blended figure: a detected bill carries whatever the vendor
  // billed in, and summing across currencies would be an invented number.
  const unpaidByCurrency = [...new Set(unpaid.map((b) => b.currency))].map((currency) => ({
    currency,
    cents: unpaid.filter((b) => b.currency === currency).reduce((sum, b) => sum + b.total_cents, 0),
  }));

  const header = (
    <View style={{ marginBottom: 16 }}>
      <Pressable style={styles.newButton} onPress={() => router.push("/bills/new")} testID="create-bill-button">
        <Text style={styles.newButtonText}>+ New bill</Text>
      </Pressable>
      {unpaid.length > 0 && (
        <View style={styles.unpaidBox} testID="unpaid-summary">
          <Text style={styles.unpaidText}>
            {unpaidByCurrency.map((g) => formatMoney(g.cents, g.currency)).join(" + ")} unpaid across{" "}
            {unpaid.length} bill{unpaid.length === 1 ? "" : "s"}
          </Text>
        </View>
      )}
      <PendingReviewList bills={pendingReview} onChanged={() => load()} />
    </View>
  );

  return (
    <View style={styles.container} testID="bills-screen">
      {loading ? (
        <>
          {header}
          <Text style={styles.empty}>Loading…</Text>
        </>
      ) : visibleBills.length === 0 && pendingReview.length === 0 ? (
        <>
          {header}
          <Text style={styles.empty} testID="no-bills">
            No bills yet. A bill is money you owe a vendor, the mirror of an invoice.
          </Text>
        </>
      ) : (
        <FlatList
          testID="bill-list"
          data={visibleBills}
          keyExtractor={(item) => item.id}
          ListHeaderComponent={header}
          renderItem={({ item }) => {
            const statusStyle = STATUS_STYLES[item.status] ?? STATUS_STYLES.unpaid;
            const urgent = urgency(item.due_date, item.status);
            return (
              <Pressable style={styles.row} testID="bill-row" onPress={() => router.push(`/bills/${item.id}`)}>
                <View style={styles.rowLeft}>
                  <Text style={styles.rowName} numberOfLines={1}>{item.vendor_name}</Text>
                  <Text style={styles.rowNumber} numberOfLines={1}>
                    {item.bill_number}
                    {item.due_date ? ` · due ${item.due_date}` : ""}
                  </Text>
                </View>
                <View style={styles.rowRight}>
                  {urgent ? (
                    <Text
                      style={[styles.statusBadge, { backgroundColor: urgent.style.bg, color: urgent.style.fg }]}
                      testID="bill-urgency"
                    >
                      {urgent.label}
                    </Text>
                  ) : (
                    <Text style={[styles.statusBadge, { backgroundColor: statusStyle.bg, color: statusStyle.fg }]}>
                      {item.status}
                    </Text>
                  )}
                  <Text style={styles.rowAmount}>{formatMoney(item.total_cents, item.currency)}</Text>
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
  container: { flex: 1, padding: 24 },
  newButton: { backgroundColor: "#0f766e", borderRadius: 8, padding: 12, alignItems: "center" },
  newButtonText: { color: "#fff", fontWeight: "600" },
  unpaidBox: { backgroundColor: "#fffbeb", borderWidth: 1, borderColor: "#fde68a", borderRadius: 8, padding: 10, marginTop: 12 },
  unpaidText: { fontSize: 13, color: "#92400e", fontWeight: "600" },
  empty: { color: "#71717a" },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderColor: "#e4e4e7",
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
  },
  rowLeft: { flex: 1, flexShrink: 1 },
  rowName: { fontWeight: "600" },
  rowNumber: { fontSize: 11, color: "#71717a", marginTop: 2 },
  rowRight: { alignItems: "flex-end", gap: 4, flexShrink: 0 },
  statusBadge: { fontSize: 11, fontWeight: "600", borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, overflow: "hidden" },
  rowAmount: { fontWeight: "600" },
});
