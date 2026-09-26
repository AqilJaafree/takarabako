"use client";

import { startTransition, ViewTransition } from "react";
import { ConnectionLost } from "@/components/ConnectionLost";

/// A page in the signed-in app failed to load — almost always because the
/// backend is unreachable. The connection-lost scene retries by itself; once
/// the backend answers, retry() refetches the page inside a transition so the
/// scene animates out into the page the customer was opening.
export default function Error({ error, retry }: { error: Error; retry: () => void }) {
  const backendIssue = /unreachable|fetch failed|ECONNREFUSED|backend/i.test(error.message);
  return (
    <ViewTransition exit="conn-out" default="none">
      <ConnectionLost
        onRecovered={() => startTransition(() => retry())}
        title={backendIssue ? "The box lost its connection" : "Something went wrong loading your box"}
        detail={backendIssue ? "We'll keep trying — nothing in your box is lost." : error.message}
      />
    </ViewTransition>
  );
}
