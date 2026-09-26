"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { CatFace } from "./CatFace";
import { ChatScreen } from "./ChatScreen";

/// Chat with Maneki on every customer page. Tapping the cat (the 3D one, or
/// the floating one on pages without the scene) plays the transition: the
/// cat's face grows from where you tapped until it fills the screen, opens
/// its mouth, and the dark red inside becomes the chat's translucent layer.
/// Closing plays it backwards.

type Phase = "idle" | "start" | "zoom" | "mouth" | "swallow" | "chat" | "closing";

interface ChatApi {
  openChat: (origin?: { x: number; y: number }) => void;
  /** A page's 3D cat is on screen (so the floating one hides). */
  registerStageCat: () => () => void;
}

const ChatContext = createContext<ChatApi | null>(null);

/// null outside customer pages (e.g. the kiosk), where there's no chat.
export const useChat = () => useContext(ChatContext);

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [origin, setOrigin] = useState({ x: 0, y: 0 });
  const [stageCats, setStageCats] = useState(0);
  const timers = useRef<number[]>([]);
  const phaseRef = useRef<Phase>("idle");
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  const clearTimers = () => {
    timers.current.forEach((t) => clearTimeout(t));
    timers.current = [];
  };
  const at = (ms: number, fn: () => void) => timers.current.push(window.setTimeout(fn, ms));

  const openChat = useCallback((o?: { x: number; y: number }) => {
    if (phaseRef.current !== "idle") return;
    clearTimers();
    setOrigin(o ?? { x: window.innerWidth - 60, y: window.innerHeight - 60 });
    if (reducedMotion()) {
      setPhase("chat");
      return;
    }
    // Mount the face small on the cat, let the browser paint, then grow it.
    setPhase("start");
    requestAnimationFrame(() => requestAnimationFrame(() => setPhase("zoom")));
    at(760, () => setPhase("mouth"));
    at(1080, () => setPhase("swallow"));
    at(1560, () => setPhase("chat"));
  }, []);

  const closeChat = useCallback(() => {
    clearTimers();
    if (reducedMotion()) {
      setPhase("idle");
      return;
    }
    setPhase("closing");
    at(900, () => setPhase("idle"));
  }, []);

  const registerStageCat = useCallback(() => {
    setStageCats((n) => n + 1);
    return () => setStageCats((n) => n - 1);
  }, []);

  useEffect(() => {
    if (phase === "idle") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeChat();
    };
    window.addEventListener("keydown", onKey);
    document.body.classList.add("chat-lock");
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.classList.remove("chat-lock");
    };
  }, [phase, closeChat]);

  useEffect(() => clearTimers, []);

  return (
    <ChatContext.Provider value={{ openChat, registerStageCat }}>
      {children}
      {phase === "idle" && stageCats === 0 && (
        <button
          className="cat-launcher"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            openChat({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
          }}
          aria-label="Chat with Maneki"
        >
          <span className="cat-launcher-bubble">💬 Tap me to chat</span>
          <span className="cat-launcher-face"><CatFace /></span>
        </button>
      )}
      {phase !== "idle" && (
        <div className={`chat-layer p-${phase}`} style={{ ["--ox" as string]: `${origin.x}px`, ["--oy" as string]: `${origin.y}px` }}>
          <div className="chat-dim" />
          <div className="chat-catzoom" aria-hidden="true"><CatFace /></div>
          <div className="chat-swallow" />
          {phase !== "start" && phase !== "zoom" && <ChatScreen onClose={closeChat} />}
        </div>
      )}
    </ChatContext.Provider>
  );
}
