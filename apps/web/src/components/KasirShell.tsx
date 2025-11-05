"use client";

import { ReactNode } from "react";
import { useRouter, usePathname } from "next/navigation";
import { colors, shadow, radii } from "@/theme";
import {
  IconShop,
  IconCart,
  IconReturn,
  IconDoor,
  IconLogout,
} from "@/components/icons";
import { useAuth } from "@/store/auth";

type NavItem = { label: string; href: string; icon: JSX.Element };

const navs: NavItem[] = [
  { label: "Sale", href: "/kasir/sale", icon: <IconCart /> },
  { label: "Retur", href: "/kasir/return", icon: <IconReturn /> },
  { label: "Close Day", href: "/kasir/closeday", icon: <IconDoor /> },
];

export default function KasirShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const logout = useAuth((s) => s.logout);
  const user = useAuth((s) => s.user);

  return (
    <div
      style={{
        minHeight: "100vh",
        background: colors.bgApp,
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Topbar */}
      <div
        style={{
          height: 64,
          background: `linear-gradient(135deg, ${colors.brandFrom} 0%, ${colors.brandTo} 100%)`,
          color: "white",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 20px",
          boxShadow: shadow.card,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div
            style={{
              background: "rgba(255,255,255,0.15)",
              borderRadius: 10,
              width: 40,
              height: 40,
              display: "grid",
              placeItems: "center",
            }}
          >
            <IconShop size={22} color="#ffffff" />
          </div>
          <div style={{ fontWeight: 700, letterSpacing: 0.3 }}>
            TOKO ALI POS — Kasir
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ fontSize: 13, opacity: 0.9 }}>
            {user?.username}{" "}
            <span style={{ opacity: 0.6 }}>({user?.role})</span>
          </div>
          <button
            onClick={() => {
              logout();
              router.replace("/login");
            }}
            title="Logout"
            style={{
              background: "rgba(255,255,255,0.15)",
              border: "1px solid rgba(255,255,255,0.35)",
              color: "white",
              padding: "6px 10px",
              borderRadius: 8,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <IconLogout color="#ffffff" />
            <span>Logout</span>
          </button>
        </div>
      </div>

      {/* Body */}
      <div style={{ flex: 1, display: "flex", gap: 14, padding: 14 }}>
        {/* Sidebar */}
        <div
          style={{
            width: 220,
            background: colors.sidebarBg,
            border: `1px solid ${colors.line}`,
            borderRadius: radii.card,
            boxShadow: shadow.card,
            padding: 10,
            height: "calc(100vh - 64px - 28px)",
            position: "sticky",
            top: 14,
          }}
        >
          {navs.map((n) => {
            const active = pathname?.startsWith(n.href);
            return (
              <button
                key={n.href}
                onClick={() => router.push(n.href)}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  textAlign: "left",
                  padding: "10px 12px",
                  background: active ? "rgba(37,99,235,0.1)" : "transparent",
                  color: active ? colors.brandFrom : colors.textSoft,
                  border: `1px solid ${
                    active ? colors.brandFrom : colors.line
                  }`,
                  borderRadius: 10,
                  cursor: "pointer",
                  marginBottom: 10,
                }}
              >
                {n.icon}
                <span style={{ fontWeight: 600 }}>{n.label}</span>
              </button>
            );
          })}
        </div>

        {/* Content */}
        <div
          style={{
            flex: 1,
            background: colors.bgCard,
            borderRadius: radii.card,
            border: `1px solid ${colors.line}`,
            boxShadow: shadow.card,
            padding: 16,
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
