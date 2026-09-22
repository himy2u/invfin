import { useCallback, useState } from "react";
import { View, Text, FlatList, Pressable, StyleSheet } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { supabase } from "../../lib/supabase";

type ClientRow = { id: string; name: string; email: string | null; phone: string | null };

export default function ClientsScreen() {
  const router = useRouter();
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [loading, setLoading] = useState(true);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      setLoading(true);
      supabase
        .from("clients")
        .select("id, name, email, phone")
        .order("name")
        .then(({ data }) => {
          if (!cancelled) {
            setClients(data ?? []);
            setLoading(false);
          }
        });
      return () => {
        cancelled = true;
      };
    }, []),
  );

  return (
    <View style={styles.container} testID="clients-screen">
      {loading ? (
        <Text style={styles.empty}>Loading…</Text>
      ) : clients.length === 0 ? (
        <Text style={styles.empty} testID="no-clients">
          No clients yet. Clients are created automatically the first time you invoice them.
        </Text>
      ) : (
        <FlatList
          testID="client-list"
          data={clients}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <Pressable style={styles.row} testID="client-row" onPress={() => router.push(`/clients/${item.id}`)}>
              <Text style={styles.rowName}>{item.name}</Text>
              <Text style={styles.rowSub}>{item.email ?? item.phone}</Text>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24 },
  empty: { color: "#71717a" },
  row: { borderWidth: 1, borderColor: "#e4e4e7", borderRadius: 12, padding: 12, marginBottom: 8 },
  rowName: { fontWeight: "600" },
  rowSub: { fontSize: 12, color: "#71717a", marginTop: 2 },
});
