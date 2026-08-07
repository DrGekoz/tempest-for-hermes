import { useEffect, useRef, useState } from "react";
import { Loader, Send, X } from "lucide-react";

interface Props {
  port: number;
  onClose: () => void;
}

interface Msg {
  role: "user" | "assistant";
  text: string;
  pending?: boolean;
}

// Streams NDJSON events from Eve's HTTP channel.
// Consumes `message.appended.data.messageDelta` chunks into the current
// assistant message; ends on `message.completed` or `session.waiting`.
async function streamInto(port: number, sessionId: string, onDelta: (s: string) => void, onDone: () => void) {
  const res = await fetch(`http://localhost:${port}/eve/v1/session/${sessionId}/stream`, {
    method: "GET",
  });
  if (!res.body) { onDone(); return; }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === "message.appended" && ev.data?.messageDelta) {
          onDelta(ev.data.messageDelta);
        }
        if (ev.type === "message.completed" || ev.type === "session.waiting") {
          onDone();
          return;
        }
      } catch { /* skip malformed */ }
    }
  }
  onDone();
}

export function ChatPanel({ port, onClose }: Props) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    setInput("");
    setMessages(prev => [...prev, { role: "user", text }, { role: "assistant", text: "", pending: true }]);
    try {
      const url = sessionId
        ? `http://localhost:${port}/eve/v1/session/${sessionId}`
        : `http://localhost:${port}/eve/v1/session`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      const body = await res.json();
      const sid: string = body.sessionId || sessionId!;
      if (!sessionId) setSessionId(sid);
      await streamInto(
        port,
        sid,
        delta => setMessages(prev => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last && last.role === "assistant") {
            next[next.length - 1] = { ...last, text: last.text + delta, pending: true };
          }
          return next;
        }),
        () => setMessages(prev => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last && last.role === "assistant") next[next.length - 1] = { ...last, pending: false };
          return next;
        }),
      );
    } catch (e) {
      setMessages(prev => {
        const next = [...prev];
        next[next.length - 1] = { role: "assistant", text: `Error: ${e}`, pending: false };
        return next;
      });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="am-chat">
      <div className="am-chat-head">
        <span className="am-chat-title">Agent · :{port}</span>
        <button className="am-chat-close" onClick={onClose} aria-label="Close"><X size={14} /></button>
      </div>
      <div className="am-chat-list" ref={listRef}>
        {messages.length === 0 && (
          <div className="am-chat-empty">Send a message to start.</div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`am-chat-msg am-chat-msg--${m.role}`}>
            <div className="am-chat-msg-body">
              {m.text || (m.pending && <span className="am-chat-thinking"><Loader size={12} className="am-spin" /> thinking…</span>)}
            </div>
          </div>
        ))}
      </div>
      <div className="am-chat-input-row">
        <textarea
          className="am-chat-input"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder="Message the agent…"
          rows={2}
          disabled={sending}
        />
        <button className="am-chat-send" onClick={send} disabled={sending || !input.trim()}>
          {sending ? <Loader size={13} className="am-spin" /> : <Send size={13} />}
        </button>
      </div>
    </div>
  );
}
