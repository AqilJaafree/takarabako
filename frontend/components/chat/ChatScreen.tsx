"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Markdown } from "@/components/Markdown";
import { apy, shortHex, usd } from "@/lib/format";
import type { Card, ChatMessage, ChatSessionSummary } from "./types";
import { CatFace } from "./CatFace";

/// The chat with Maneki: saved conversations on the side, messages with the
/// cards the assistant makes (deposit QR, confirm-before-acting), and a
/// composer that takes images and PDFs (read by the model, not stored).

const SUGGESTIONS = [
  "What's in my box right now?",
  "Show my deposit QR",
  "Which yield tier suits me?",
  "Why was a note not credited?",
  "Where's the kiosk?",
];
const MAX_FILES = 3;
const MAX_MB = 8;

interface PendingFile {
  name: string;
  type: string;
  dataUrl: string;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error ?? "something went wrong"), { status: res.status });
  return body as T;
}

const readFile = (f: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });

export function ChatScreen({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const onAuthError = useCallback(
    (e: unknown) => {
      if ((e as { status?: number }).status === 401) {
        router.replace("/login");
        return true;
      }
      return false;
    },
    [router],
  );

  const loadSessions = useCallback(async () => {
    try {
      const r = await api<{ sessions: ChatSessionSummary[] }>("/api/chat/sessions");
      setSessions(r.sessions);
    } catch (e) {
      onAuthError(e);
    }
  }, [onAuthError]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads once on open; state updates after the fetch
    void loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  async function openSession(id: string) {
    setShowHistory(false);
    setError("");
    try {
      const r = await api<{ session: { id: string; messages: ChatMessage[] } }>(`/api/chat/sessions/${id}`);
      setCurrent(id);
      setMessages(r.session.messages);
    } catch (e) {
      if (!onAuthError(e)) setError(e instanceof Error ? e.message : "couldn't open that chat");
    }
  }

  function newChat() {
    setShowHistory(false);
    setCurrent(null);
    setMessages([]);
    setError("");
  }

  async function removeSession(id: string) {
    try {
      await api(`/api/chat/sessions/${id}`, { method: "DELETE" });
      if (id === current) newChat();
      await loadSessions();
    } catch (e) {
      onAuthError(e);
    }
  }

  async function addFiles(list: FileList | null) {
    if (!list) return;
    setError("");
    const next = [...files];
    for (const f of Array.from(list)) {
      if (next.length >= MAX_FILES) {
        setError(`Up to ${MAX_FILES} files at a time`);
        break;
      }
      if (!/^image\/|^application\/pdf$/.test(f.type)) {
        setError(`${f.name}: only images and PDFs`);
        continue;
      }
      if (f.size > MAX_MB * 1024 * 1024) {
        setError(`${f.name} is over ${MAX_MB} MB`);
        continue;
      }
      next.push({ name: f.name, type: f.type, dataUrl: await readFile(f) });
    }
    setFiles(next);
    if (fileInput.current) fileInput.current.value = "";
  }

  async function send(prompt?: string) {
    const body = (prompt ?? text).trim();
    if ((!body && files.length === 0) || busy) return;
    setBusy(true);
    setError("");
    const sending = files;
    const optimistic: ChatMessage = {
      id: `tmp-${crypto.randomUUID()}`,
      role: "user",
      content: body,
      attachments: sending.map((f) => ({ name: f.name, type: f.type })),
      cards: [],
      createdAt: new Date().toISOString(),
    };
    setMessages((m) => [...m, optimistic]);
    setText("");
    setFiles([]);
    try {
      let id = current;
      if (!id) {
        id = (await api<{ session: ChatSessionSummary }>("/api/chat/sessions", { method: "POST" })).session.id;
        setCurrent(id);
      }
      const r = await api<{ user: ChatMessage; reply: ChatMessage }>(`/api/chat/sessions/${id}/messages`, {
        method: "POST",
        body: JSON.stringify({ text: body, files: sending }),
      });
      setMessages((m) => [...m.filter((x) => x.id !== optimistic.id), r.user, r.reply]);
      void loadSessions();
    } catch (e) {
      if (!onAuthError(e)) {
        setMessages((m) => m.filter((x) => x.id !== optimistic.id));
        setText(body);
        setFiles(sending);
        setError(e instanceof Error ? e.message : "couldn't send");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="chat-screen" role="dialog" aria-modal="true" aria-label="Chat with Maneki">
      <aside className={`chat-side${showHistory ? " is-open" : ""}`}>
        <button className="btn btn-gold btn-block small" onClick={newChat}>＋ New chat</button>
        <p className="label" style={{ margin: "14px 0 6px" }}>Your chats</p>
        {sessions.length === 0 ? (
          <p className="muted small">No saved chats yet.</p>
        ) : (
          <ul className="chat-sessions">
            {sessions.map((s) => (
              <li key={s.id} className={s.id === current ? "is-on" : ""}>
                <button className="chat-session" onClick={() => openSession(s.id)}>
                  <span>{s.title}</span>
                  <span className="muted small" suppressHydrationWarning>{new Date(s.updatedAt).toLocaleDateString()}</span>
                </button>
                <button className="chat-session-del" onClick={() => removeSession(s.id)} aria-label={`Delete ${s.title}`}>×</button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <section className="chat-main">
        <header className="chat-head">
          <button className="btn btn-ghost small chat-history-toggle" onClick={() => setShowHistory((v) => !v)} aria-expanded={showHistory}>
            ☰ Chats
          </button>
          <span className="chat-avatar"><CatFace /></span>
          <div>
            <b>Maneki</b>
            <span className="muted small"> · your treasure-box assistant</span>
          </div>
          <button className="chat-close" onClick={onClose} aria-label="Close chat">×</button>
        </header>

        <div className="chat-messages" ref={scroller} aria-live="polite">
          {messages.length === 0 && (
            <div className="chat-empty">
              <span className="chat-empty-cat"><CatFace /></span>
              <h2>Nya! I&apos;m Maneki.</h2>
              <p className="muted">I know your box, your deposits and your receipts. Ask me anything, or send a photo or PDF for feedback.</p>
              <div className="chat-suggestions">
                {SUGGESTIONS.map((s) => (
                  <button key={s} className="chip btn btn-ghost small" onClick={() => send(s)} disabled={busy}>{s}</button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m) => (
            <div key={m.id} className={`chat-msg ${m.role}`}>
              {m.role === "assistant" && <span className="chat-avatar sm"><CatFace /></span>}
              <div className="chat-bubble">
                {m.content && (m.role === "assistant" ? <Markdown text={m.content} /> : <p>{m.content}</p>)}
                {m.attachments.length > 0 && (
                  <div className="chat-files">
                    {m.attachments.map((a, i) => (
                      <span key={i} className="chat-file">{a.type === "application/pdf" ? "📄" : "🖼"} {a.name}</span>
                    ))}
                  </div>
                )}
                {m.cards.map((c, i) => <ChatCard key={i} card={c} />)}
              </div>
            </div>
          ))}
          {busy && (
            <div className="chat-msg assistant">
              <span className="chat-avatar sm"><CatFace /></span>
              <div className="chat-bubble chat-typing" aria-label="Maneki is thinking"><i /><i /><i /></div>
            </div>
          )}
        </div>

        <form
          className="chat-composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          {error && <p className="small tone-bad" style={{ margin: "0 0 6px" }}>{error}</p>}
          {files.length > 0 && (
            <div className="chat-files pending">
              {files.map((f, i) => (
                <span key={i} className="chat-file">
                  {f.type === "application/pdf" ? "📄" : "🖼"} {f.name}
                  <button type="button" onClick={() => setFiles(files.filter((_, j) => j !== i))} aria-label={`Remove ${f.name}`}>×</button>
                </span>
              ))}
            </div>
          )}
          <div className="chat-input-row">
            <button type="button" className="chat-attach" onClick={() => fileInput.current?.click()} aria-label="Attach an image or PDF" disabled={busy}>📎</button>
            <input ref={fileInput} type="file" accept="image/*,application/pdf" multiple hidden onChange={(e) => addFiles(e.target.files)} />
            <textarea
              className="chat-input"
              rows={1}
              placeholder="Ask Maneki…"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <button className="btn btn-gold chat-send" disabled={busy || (!text.trim() && files.length === 0)}>Send</button>
          </div>
          <p className="muted small chat-note">Maneki never moves money on its own — actions always ask you to confirm. Files are read, not kept.</p>
        </form>
      </section>
    </div>
  );
}

// ---- cards ---------------------------------------------------------------

function ChatCard({ card }: { card: Card }) {
  if (card.type === "qr") return <QrCard card={card} />;
  if (card.type === "link") return <a className="btn small" href={card.href}>{card.label}</a>;
  return <ConfirmCard card={card} />;
}

function QrCard({ card }: { card: Extract<Card, { type: "qr" }> }) {
  // Greys out when the 5-minute QR expires, even while it's on screen.
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setExpired(true), Math.max(0, Date.parse(card.expiresAt) - Date.now()));
    return () => clearTimeout(t);
  }, [card.expiresAt]);
  return (
    <div className="chat-card qr">
      {/* eslint-disable-next-line @next/next/no-img-element -- data URL from the backend */}
      <img src={card.dataUrl} alt="Your deposit QR" width={220} height={220} className={expired ? "is-expired" : ""} />
      <p className="small" style={{ margin: "8px 0 0" }}>
        {expired ? (
          <>This QR has expired. Ask me for a new one, or open <a href="/qr">Deposit</a>.</>
        ) : (
          <>Show this to the kiosk camera · valid until <span suppressHydrationWarning>{new Date(card.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span></>
        )}
      </p>
    </div>
  );
}

function ConfirmCard({ card }: { card: Extract<Card, { type: "confirm_yield" | "confirm_withdraw" }> }) {
  const [state, setState] = useState<{ kind: "ask" | "busy" | "cancelled" } | { kind: "done"; text: string } | { kind: "error"; text: string }>({ kind: "ask" });

  async function confirm() {
    setState({ kind: "busy" });
    try {
      if (card.type === "confirm_yield") {
        const r = await api<{ ensName?: string; pair?: string }>("/api/yield", {
          method: "POST",
          body: JSON.stringify({ riskLevel: card.riskTier, amount: card.amountUsd }),
        });
        setState({ kind: "done", text: `Opened ${card.label}${r.ensName ? ` · ${r.ensName}` : ""}` });
      } else {
        const r = await api<{ receipt?: string }>("/api/withdraw", { method: "POST" });
        setState({ kind: "done", text: r.receipt ?? "Sent to your wallet" });
      }
    } catch (e) {
      setState({ kind: "error", text: e instanceof Error ? e.message : "it didn't go through" });
    }
  }

  const title =
    card.type === "confirm_yield"
      ? `Put ${usd(card.amountUsd)} into ${card.label}`
      : `Withdraw ${usd(card.amountUsd)} to your wallet`;
  const detail =
    card.type === "confirm_yield"
      ? `~${apy(card.apyBps)} APY (estimate) · ${card.range}`
      : `To ${shortHex(card.wallet, 8, 6)} · no fee`;

  return (
    <div className={`chat-card confirm st-${state.kind}`}>
      <p className="label" style={{ margin: 0 }}>Needs your OK</p>
      <b className="chat-card-title">{title}</b>
      <span className="muted small">{detail}</span>
      {card.reason && <p className="small" style={{ margin: "6px 0 0" }}>{card.reason}</p>}
      {state.kind === "ask" && (
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn btn-gold small" onClick={confirm}>Confirm</button>
          <button className="btn btn-ghost small" onClick={() => setState({ kind: "cancelled" })}>Cancel</button>
        </div>
      )}
      {state.kind === "busy" && <p className="small muted" style={{ margin: "10px 0 0" }}>Working on it…</p>}
      {state.kind === "cancelled" && <p className="small muted" style={{ margin: "10px 0 0" }}>Cancelled — nothing was done.</p>}
      {state.kind === "done" && <p className="small tone-ok" style={{ margin: "10px 0 0" }}>✓ {state.text}</p>}
      {state.kind === "error" && <p className="small tone-bad" style={{ margin: "10px 0 0" }}>✗ {state.text}</p>}
    </div>
  );
}
