import { PrivyShell } from "@/components/PrivyShell";

export default function CustomerLayout({ children }: { children: React.ReactNode }) {
  return <PrivyShell>{children}</PrivyShell>;
}
