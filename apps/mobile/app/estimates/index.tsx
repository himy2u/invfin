import { useCallback, useState } from "react";
import { View, Text, FlatList, Pressable, StyleSheet } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { supabase } from "../../lib/supabase";

type EstimateRow = {
  id: string;
  estimate_number: string;
  status: string;
  total_cents: number;
  currency: string;
  clients: { name: string } | null;
};

const STATUS_STYLES: Record<string, { bg: string; fg: string }> = {
  draft: { bg: "#f4f4f5", fg: "#3f3f46" },
  sent: { bg: "#e0f2fe", fg: "#075985" },
  accepted: { bg: "#d1fae5", fg: "#065f46" },
  declined: { bg: "#fee2e2", fg: "#b91c1c" },
  expired: { bg: "#fef3c7", fg: "#92400e" },
  converted: { bg: "#ccfbf1", fg: "#115e59" },
};

export default function EstimatesScreen() {
  const router = useRouter();
  const [estimates, setEstimates] = useState<EstimateRow[]>([]);
  const [loading, setLoading] = useState(true);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      setLoading(true);
      supabase
        .from("estimates")
        .select("id, estimate_number, status, total_cents, currency, clients(name)")
        .order("created_at", { ascending: false })
        .then(({ data }) => {
          if (!cancelled) {
            setEstimates((data as EstimateRow[]) ?? []);
            setLoading(false);
          }
        });
      return () => {
        cancelled = true;
      };
    }, []),
  );

  const header = (
    <View style={{ marginBottom: 16 }}>
      <Pressable style={styles.newButton} onPress={() => router.push("/estimates/new")} testID="create-estimate-button">
        <Text style={styles.newButtonText}>+ New estimate</Text>
      </Pressable>
    </View>
  );

  return (
    <View style={styles.container} testID="estimates-screen">
      {loading ? (
        <>
          {header}
          <Text style={styles.empty}>Loading…</Text>
        </>
      ) : estimates.length === 0 ? (
        <>
          {header}
          <Text style={styles.empty} testID="no-estimates">
            No estimates yet.
          </Text>
        </>
      ) : (
        <FlatList
          testID="estimate-list"
          data={estimates}
          keyExtractor={(item) => item.id}
          ListHeaderComponent={header}
          renderItem={({ item }) => {
            const statusStyle = STATUS_STYLES[item.status] ?? STATUS_STYLES.draft;
            return (
              <Pressable style={styles.row} testID="estimate-row" onPress={() => router.push(`/estimates/${item.id}`)}>
                <View style={styles.rowLeft}>
                  <Text style={styles.rowName} numberOfLines={1}>{item.clients?.name ?? "Unknown client"}</Text>
                  <Text style={styles.rowNumber}>{item.estimate_number}</Text>
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
  container: { flex: 1, padding: 24 },
  newButton: { backgroundColor: "#0f766e", borderRadius: 8, padding: 12, alignItems: "center" },
  newButtonText: { color: "#fff", fontWeight: "600" },
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
