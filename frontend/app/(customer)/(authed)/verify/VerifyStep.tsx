"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { WorldSelfie } from "@/components/WorldSelfie";

export function VerifyStep() {
  const router = useRouter();
  return (
    <>
      <WorldSelfie
        onVerified={() => {
          router.replace("/");
          router.refresh();
        }}
      />
      <p className="small" style={{ textAlign: "center", margin: "14px 0 0" }}>
        <Link href="/" className="muted">Later — keep the daily limit for now</Link>
      </p>
    </>
  );
}
