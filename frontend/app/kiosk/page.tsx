import { redirect } from "next/navigation";

/// The full kiosk screen (email login, withdrawals and yield at the box) is retired: the box runs the
/// deposit terminal. Old links and the Pi's bookmark land there.
export default function KioskPage() {
  redirect("/deposit");
}
