import { useAuth } from "@/store/auth";

export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:3001";

export function getDeviceId() {
  if (typeof window === "undefined") return "WEB-DEV";
  let id = localStorage.getItem("xDeviceId");
  if (!id) {
    id = `WEB-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    localStorage.setItem("xDeviceId", id);
  }
  return id;
}

export async function apiFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const state = useAuth.getState(); // ← ambil token dari store (non-hook)
  const headers: HeadersInit = {
    "Content-Type": "application/json",
    "x-device-id": getDeviceId(),
    ...(options.headers || {}),
    ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
  };

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `HTTP ${res.status} ${res.statusText} – ${text || "No body"}`
    );
  }
  return (await res.json()) as T;
}
