// apps/web/src/store/cart.ts
import { create } from "zustand";

export type CartItem = {
  productId: string;
  sku?: string | null;
  name: string;
  uom: string;
  qty: number;
  price: number;
  subtotal: number;
};

type CartState = {
  items: CartItem[];
  addItem: (it: Omit<CartItem, "subtotal">) => void;
  removeIndex: (idx: number) => void;
  setQty: (idx: number, qty: number) => void;
  clear: () => void;
  total: () => number;
};

export const useCart = create<CartState>((set, get) => ({
  items: [],
  addItem: (it) => {
    const newItem: CartItem = { ...it, subtotal: it.qty * it.price };
    set((s) => ({ items: [...s.items, newItem] }));
  },
  removeIndex: (idx) => {
    set((s) => ({ items: s.items.filter((_, i) => i !== idx) }));
  },
  setQty: (idx, qty) => {
    set((s) => {
      const items = [...s.items];
      const row = items[idx];
      if (!row) return s;
      const newQty = Math.max(0, qty);
      items[idx] = { ...row, qty: newQty, subtotal: newQty * row.price };
      return { items };
    });
  },
  clear: () => set({ items: [] }),
  total: () => get().items.reduce((a, b) => a + b.subtotal, 0),
}));
