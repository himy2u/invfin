import { useState } from "react";
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet } from "react-native";

type ChatLineItem = { description: string; quantity: number; unit_price: number };

export type InvoiceDraft = {
  client_name: string | null;
  client_email: string | null;
  client_phone: string | null;
  line_items: ChatLineItem[];
  tax_rate_percent: number;
  title: string | null;
  summary: string | null;
  po_number: string | null;
  due_date: string | null;
};

type ChatMessage = { role: "user" | "assistant"; content: string };

export function ChatInvoiceBuilder({
  onUseDraft,
  autoOpen,
}: {
  onUseDraft: (draft: InvoiceDraft) => void;
  autoOpen?: boolean;
}) {
  const [open, setOpen] = useState(autoOpen ?? false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState<InvoiceDraft | null>(null);
  const [ready, setReady] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendMessage() {
    const text = input.trim();
    if (!text || sending) return;

    const newMessages: ChatMessage[] = [...messages, { role: "user", content: text }];
    setMessages(newMessages);
    setInput("");
    setSending(true);
    setError(null);

    try {
      const agentUrl = process.env.EXPO_PUBLIC_AGENT_SERVICE_URL ?? "http://localhost:8000";
      const res = await fetch(`${agentUrl}/chat-invoice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: newMessages, draft }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "chat failed");

      setMessages((prev) => [...prev, { role: "assistant", content: data.reply }]);
      setDraft(data.draft);
      setReady(data.ready);
    } catch (err) {
      setError(err instanceof Error ? err.message : "chat failed");
    } finally {
      setSending(false);
    }
  }

  if (!open) {
    return (
      <Pressable style={styles.openButton} onPress={() => setOpen(true)} testID="open-chat-builder-button">
        <Text style={styles.openButtonText}>💬 Talk to build this invoice</Text>
      </Pressable>
    );
  }

  return (
    <View style={styles.container} testID="chat-invoice-builder">
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Talk to build this invoice</Text>
        <Pressable onPress={() => setOpen(false)}>
          <Text style={styles.closeText}>Close</Text>
        </Pressable>
      </View>

      <ScrollView style={styles.messagesBox} testID="chat-messages">
        {messages.length === 0 && (
          <Text style={styles.hint}>
            Try: &quot;bill Riverside Cafe $2000 for the kitchen remodel, due in 30 days&quot;
          </Text>
        )}
        {messages.map((m, i) => (
          <View
            key={i}
            style={[styles.bubble, m.role === "user" ? styles.bubbleUser : styles.bubbleAssistant]}
            testID={m.role === "user" ? "chat-user-message" : "chat-assistant-message"}
          >
            <Text style={m.role === "user" ? styles.bubbleUserText : styles.bubbleAssistantText}>{m.content}</Text>
          </View>
        ))}
      </ScrollView>

      {draft && (draft.client_name || draft.line_items.length > 0) && (
        <View style={styles.draftBox} testID="chat-draft-preview">
          {draft.client_name && <Text style={styles.draftClient}>{draft.client_name}</Text>}
          {draft.line_items.map((item, i) => (
            <Text key={i} style={styles.draftLine}>
              {item.description}: {item.quantity} × {item.unit_price.toFixed(2)}
            </Text>
          ))}
          {draft.tax_rate_percent > 0 && <Text style={styles.draftLine}>Tax: {draft.tax_rate_percent}%</Text>}
        </View>
      )}

      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder="Type your message…"
          editable={!sending}
          testID="chat-input"
        />
        <Pressable style={styles.sendButton} onPress={sendMessage} disabled={sending || !input.trim()} testID="chat-send-button">
          <Text style={styles.sendButtonText}>{sending ? "…" : "Send"}</Text>
        </Pressable>
      </View>

      {error && <Text style={styles.error}>{error}</Text>}

      {ready && draft && (
        <Pressable style={styles.useDraftButton} onPress={() => onUseDraft(draft)} testID="use-chat-draft-button">
          <Text style={styles.useDraftButtonText}>Use this draft →</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  openButton: { borderWidth: 1, borderColor: "#5eead4", backgroundColor: "#fff", borderRadius: 8, padding: 10, alignItems: "center", marginBottom: 8 },
  openButtonText: { color: "#0f766e", fontWeight: "600", fontSize: 13 },
  container: { borderWidth: 1, borderColor: "#5eead4", borderRadius: 8, padding: 12, marginBottom: 8 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  headerTitle: { fontSize: 13, fontWeight: "600", color: "#134e4a" },
  closeText: { fontSize: 13, color: "#71717a" },
  messagesBox: { maxHeight: 180, marginBottom: 8 },
  hint: { fontSize: 13, color: "#71717a" },
  bubble: { borderRadius: 8, padding: 8, marginBottom: 6, maxWidth: "85%" },
  bubbleUser: { backgroundColor: "#0f766e", alignSelf: "flex-end" },
  bubbleAssistant: { backgroundColor: "#f4f4f5", alignSelf: "flex-start" },
  bubbleUserText: { color: "#fff", fontSize: 13 },
  bubbleAssistantText: { color: "#3f3f46", fontSize: 13 },
  draftBox: { borderWidth: 1, borderColor: "#e4e4e7", backgroundColor: "#fafafa", borderRadius: 8, padding: 8, marginBottom: 8 },
  draftClient: { fontSize: 12, fontWeight: "600", color: "#3f3f46" },
  draftLine: { fontSize: 11, color: "#71717a" },
  inputRow: { flexDirection: "row", gap: 8 },
  input: { flex: 1, borderWidth: 1, borderColor: "#d4d4d8", borderRadius: 8, padding: 10, fontSize: 13 },
  sendButton: { backgroundColor: "#0f766e", borderRadius: 8, paddingHorizontal: 16, justifyContent: "center" },
  sendButtonText: { color: "#fff", fontWeight: "600", fontSize: 13 },
  error: { color: "#dc2626", fontSize: 13, marginTop: 8 },
  useDraftButton: { backgroundColor: "#0f766e", borderRadius: 8, padding: 12, alignItems: "center", marginTop: 10 },
  useDraftButtonText: { color: "#fff", fontWeight: "600", fontSize: 13 },
});
