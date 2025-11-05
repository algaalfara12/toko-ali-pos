"use client";

import { useEffect, useState } from "react";
import { API_BASE, apiFetch } from "@/utils/api";
import { useAuth } from "@/store/auth";

export default function TestAuthPage() {
  const [msg, setMsg] = useState("Test Auth Page");
  const setToken = useAuth((s) => s.setToken);

  useEffect(() => {
    (async () => {
      try {
        // login → simpan token ke store
        const r = await fetch(`${API_BASE}/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: "admin", password: "admin123" }),
        });
        if (!r.ok) {
          const t = await r.text();
          setMsg(`Login ERR: ${r.status} ${t}`);
          return;
        }
        const data = await r.json();
        setToken(data.token);

        // panggil endpoint protected (misal /users list)
        const users = await apiFetch<{ ok: boolean; data: any[] }>("/users");
        setMsg(`Protected OK. users=${users.data.length}`);
      } catch (e: any) {
        setMsg(`ERR: ${e?.message || e}`);
      }
    })();
  }, [setToken]);

  return (
    <div style={{ padding: 16 }}>
      <h1>/test-auth</h1>
      <div>{msg}</div>
    </div>
  );
}
