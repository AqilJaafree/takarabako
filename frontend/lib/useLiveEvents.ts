"use client";

import { useEffect, useRef, useState } from "react";
import type { LiveEvent } from "./types";

export type LiveStatus = "connecting" | "live" | "polling";

/// Follows a same-origin SSE route (/api/stream or /api/kiosk/stream, which
/// proxy the backend's per-user stream). While the stream is down, `poll`
/// runs every `pollMs` so the screen still catches up; the browser keeps
/// retrying the stream meanwhile, and polling stops once it's back.
export function useLiveEvents(
  url: string | null,
  onEvent: (e: LiveEvent) => void,
  poll?: () => Promise<void> | void,
  pollMs = 3000,
): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const onEventRef = useRef(onEvent);
  const pollRef = useRef(poll);
  useEffect(() => {
    onEventRef.current = onEvent;
    pollRef.current = poll;
  });

  useEffect(() => {
    if (!url) return;
    let source: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let reopenTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const startPolling = () => {
      setStatus("polling");
      if (pollTimer || !pollRef.current) return;
      pollTimer = setInterval(() => void pollRef.current?.(), pollMs);
    };
    const stopPolling = () => {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
    };

    const open = () => {
      if (closed) return;
      source = new EventSource(url);
      source.onopen = () => {
        stopPolling();
        setStatus("live");
      };
      source.onmessage = (msg) => {
        try {
          onEventRef.current(JSON.parse(msg.data) as LiveEvent);
        } catch {
          // ignore malformed frames
        }
      };
      source.onerror = () => {
        startPolling();
        // A non-200 answer (e.g. the backend restarting) closes an EventSource
        // for good; reopen it ourselves. Plain drops are retried by the browser.
        if (source?.readyState === EventSource.CLOSED) {
          source = null;
          reopenTimer = setTimeout(open, 5000);
        }
      };
    };
    open();

    return () => {
      closed = true;
      source?.close();
      stopPolling();
      if (reopenTimer) clearTimeout(reopenTimer);
    };
  }, [url, pollMs]);

  return status;
}
