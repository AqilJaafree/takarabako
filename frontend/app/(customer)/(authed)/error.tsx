"use client";

export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="card">
      <div className="notice error">{error.message || "Something went wrong loading your box."}</div>
      <button className="btn" onClick={reset}>Try again</button>
    </div>
  );
}
