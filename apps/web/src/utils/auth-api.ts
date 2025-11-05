// apps/web/src/utils/auth-api.ts
import { API_BASE } from "./api";

export async function loginApi(username: string, password: string) {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as { token: string };
}

export async function fetchMe(token: string) {
  const res = await fetch(`${API_BASE}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as {
    ok: boolean;
    user: {
      id: string;
      username: string;
      role: "admin" | "kasir" | "petugas_gudang";
    };
  };
}
