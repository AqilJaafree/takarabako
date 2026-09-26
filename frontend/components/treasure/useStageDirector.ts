"use client";

import { useCallback, useRef, useState } from "react";
import { cash, shortHex, usd } from "@/lib/format";
import type { CatMood, StageNote } from "./types";

export type DepositCue =
  | { status: "pending"; amount: number; currency: string; estUsd: number | null }
  | { status: "retrying"; attempt: number; of: number }
  | { status: "confirmed"; amount: number; currency: string; usdAmount: number; txHash?: string }
  | { status: "failed"; amount: number; currency: string; error: string };

/// Turns deposit events into stage directions: which notes are in flight,
/// what the cat says, how it feels, when it hops and when coins burst out.
/// Scripted lines are instant; `say` is for the live Claude agent's words.
export function useStageDirector(greeting: string) {
  const [notes, setNotes] = useState<StageNote[]>([]);
  const [mood, setMood] = useState<CatMood>("idle");
  const [line, setLine] = useState(greeting);
  const [hop, setHop] = useState(0);
  const [burst, setBurst] = useState(0);
  const [etch, setEtch] = useState<string | null>(null);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const etchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /// Show a line; after `ms` the cat calms down again (0 = keep it).
  const say = useCallback((text: string, nextMood: CatMood = "idle", ms = 6000) => {
    if (settle.current) clearTimeout(settle.current);
    setLine(text);
    setMood(nextMood);
    if (ms > 0) {
      settle.current = setTimeout(() => {
        setMood("idle");
        setLine("");
      }, ms);
    }
  }, []);

  const deposit = useCallback(
    (id: string, cue: DepositCue) => {
      if (cue.status === "pending") {
        setNotes((list) => (list.some((n) => n.id === id) ? list : [...list, { id, amount: cue.amount, currency: cue.currency, status: "pending" }]));
        setHop((h) => h + 1);
        say(`${cash(cue.amount, cue.currency)} landed! Checking the chain…`, "happy", 0);
      } else if (cue.status === "retrying") {
        say(`The chain is slow — trying again (${cue.attempt}/${cue.of})…`, "thinking", 0);
      } else if (cue.status === "confirmed") {
        setNotes((list) => list.map((n) => (n.id === id ? { ...n, status: "confirmed" } : n)));
        setHop((h) => h + 1);
        say(`Confirmed! +${usd(cue.usdAmount)} in your box 🎉`, "happy");
        if (cue.txHash) {
          if (etchTimer.current) clearTimeout(etchTimer.current);
          setEtch(shortHex(cue.txHash, 8, 6));
          etchTimer.current = setTimeout(() => setEtch(null), 5000);
        }
      } else {
        setNotes((list) => list.map((n) => (n.id === id ? { ...n, status: "failed" } : n)));
        say(`Nyaa… ${cash(cue.amount, cue.currency)} didn't go through. It's recorded — staff can re-send it.`, "worried", 9000);
      }
    },
    [say],
  );

  const noteDone = useCallback((id: string) => setNotes((list) => list.filter((n) => n.id !== id)), []);

  const withdraw = useCallback(() => {
    setBurst((b) => b + 1);
    say("Off to your wallet! お疲れさま", "happy");
  }, [say]);

  return { stage: { notes, mood, line, hop, burst, etch, onNoteDone: noteDone }, deposit, say, withdraw };
}
