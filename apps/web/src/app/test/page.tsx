"use client";

import { useEffect, useState } from "react";

export default function TestPage() {
  const [msg, setMsg] = useState("Test API Login");

  useEffect(() => {
    (async () => {
      try {
        const API = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:3001";
        // OPTION: health ping dulu, supaya gampang debug koneksi
        const ping = await fetch(`${API}/health`, { method: "GET" });
        if (!ping.ok) {
          setMsg(`ERR: /health ${ping.status}`);
          return;
        }

        const r = await fetch(`${API}/auth/login`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // x-device-id tidak wajib untuk /auth/login, hanya untuk sync.
          },
          body: JSON.stringify({ username: "admin", password: "admin123" }),
        });

        if (!r.ok) {
          const t = await r.text();
          setMsg(`ERR: ${r.status} ${t}`);
          return;
        }

        const data = await r.json();
        setMsg(`OK. Token length=${(data?.token || "").length}`);
      } catch (e: any) {
        setMsg(`ERR: ${e?.message || e}`);
      }
    })();
  }, []);

  return (
    <div style={{ padding: 16 }}>
      <h1>Test API Login</h1>
      <div>{msg}</div>
    </div>
  );
}
