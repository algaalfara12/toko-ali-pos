import Protected from "@/components/Protected";
import KasirShell from "@/components/KasirShell";

export default function KasirLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Protected>
      <KasirShell>{children}</KasirShell>
    </Protected>
  );
}
