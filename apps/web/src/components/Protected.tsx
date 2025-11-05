"use client";
import { ReactNode, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/store/auth";

// Izinkan kasir & admin (biar admin bisa uji fitur kasir)
const ALLOWED_ROLES = ["kasir", "admin"];

export default function Protected({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { token, user } = useAuth();

  useEffect(() => {
    if (!token) {
      router.replace("/login");
      return;
    }
    if (!user || !ALLOWED_ROLES.includes(user.role)) {
      router.replace("/login");
    }
  }, [token, user, router]);

  if (!token || !user) return null;
  if (!ALLOWED_ROLES.includes(user.role)) return null;

  return <>{children}</>;
}
