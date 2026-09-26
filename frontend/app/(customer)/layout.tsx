import { PrivyShell } from "@/components/PrivyShell";
import { BoxTransitionProvider } from "@/components/BoxTransition";

export default function CustomerLayout({ children }: { children: React.ReactNode }) {
  return (
    <PrivyShell>
      <BoxTransitionProvider>{children}</BoxTransitionProvider>
    </PrivyShell>
  );
}
