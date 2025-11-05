// apps/web/src/store/auth.ts
import { create } from "zustand";

type Role = "admin" | "kasir" | "petugas_gudang";

type AuthState = {
  token: string | null;
  user?: { id: string; username: string; role: Role } | null;
  setToken: (token: string | null, persist?: boolean) => void;
  setUser: (user: AuthState["user"]) => void;
  clear: () => void;
  initFromStorage: () => void;
};

export const useAuth = create<AuthState>((set) => ({
  token: null,
  user: null,
  setToken: (token, persist) => {
    if (persist) {
      if (token) localStorage.setItem("auth_token", token);
      else localStorage.removeItem("auth_token");
    }
    set({ token });
  },
  setUser: (user) => set({ user }),
  clear: () => {
    localStorage.removeItem("auth_token");
    set({ token: null, user: null });
  },
  initFromStorage: () => {
    const t =
      typeof window !== "undefined" ? localStorage.getItem("auth_token") : null;
    if (t) set({ token: t });
  },
}));
