"use client";

import { useState } from "react";

type ChatLineItem = { description: string; quantity: number; unit_price: number };

type InvoiceDraft = {
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
      const res = await fetch("/api/chat-invoice", {
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
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="open-chat-builder-button"
        className="rounded border border-teal-300 bg-white px-3 py-1.5 text-sm text-teal-700 hover:bg-teal-50"
      >
        💬 Talk to build this invoice
      </button>
    );
  }

  return (
    <div className="rounded-lg border border-teal-300 bg-white p-4" data-testid="chat-invoice-builder">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium text-teal-900">Talk to build this invoice</span>
        <button type="button" onClick={() => setOpen(false)} className="text-sm text-zinc-500">
          Close
        </button>
      </div>

      <div className="mb-3 flex max-h-64 flex-col gap-2 overflow-y-auto" data-testid="chat-messages">
        {messages.length === 0 && (
          <p className="text-sm text-zinc-500">
            Try: &quot;bill Riverside Cafe $2000 for the kitchen remodel, due in 30 days&quot;
          </p>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={`rounded px-3 py-2 text-sm ${
              m.role === "user" ? "self-end bg-teal-700 text-white" : "self-start bg-zinc-100 text-zinc-800"
            }`}
            data-testid={m.role === "user" ? "chat-user-message" : "chat-assistant-message"}
          >
            {m.content}
          </div>
        ))}
      </div>

      {draft && (draft.client_name || draft.line_items.length > 0) && (
        <div className="mb-3 rounded border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-600" data-testid="chat-draft-preview">
          {draft.client_name && <p className="font-medium text-zinc-800">{draft.client_name}</p>}
          {draft.line_items.map((item, i) => (
            <p key={i}>
              {item.description}: {item.quantity} × {item.unit_price.toFixed(2)}
            </p>
          ))}
          {draft.tax_rate_percent > 0 && <p>Tax: {draft.tax_rate_percent}%</p>}
        </div>
      )}

      <div className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              sendMessage();
            }
          }}
          placeholder="Type your message…"
          disabled={sending}
          data-testid="chat-input"
          className="flex-1 rounded border border-zinc-300 px-3 py-2 text-sm"
        />
        <button
          type="button"
          onClick={sendMessage}
          disabled={sending || !input.trim()}
          data-testid="chat-send-button"
          className="rounded bg-teal-700 px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          {sending ? "…" : "Send"}
        </button>
      </div>

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      {ready && draft && (
        <button
          type="button"
          onClick={() => onUseDraft(draft)}
          data-testid="use-chat-draft-button"
          className="mt-3 w-full rounded bg-teal-700 px-4 py-2 text-sm font-medium text-white hover:bg-teal-800"
        >
          Use this draft →
        </button>
      )}
    </div>
  );
}
