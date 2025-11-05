"use client";
import { useState } from "react";
import { colors } from "@/theme";
import { useCart } from "@/store/cart";
import CartPanel from "@/components/CartPanel";

export default function KasirSalePage() {
  const addItem = useCart((s) => s.addItem);

  // sementara: form manual tambah item
  const [form, setForm] = useState({
    productId: "",
    sku: "",
    name: "",
    uom: "1kg",
    qty: 1,
    price: 10000,
  });

  return (
    <div>
      <h2 style={{ marginBottom: 12, color: colors.textDark }}>
        Kasir — Penjualan
      </h2>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 16,
        }}
      >
        {/* Kiri: form input sementara */}
        <div
          style={{
            padding: 12,
            border: `1px solid ${colors.line}`,
            borderRadius: 12,
            background: "white",
          }}
        >
          <h4 style={{ marginBottom: 10 }}>Tambah Item (sementara)</h4>
          <div
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}
          >
            <div>
              <label>ProductId</label>
              <input
                value={form.productId}
                onChange={(e) =>
                  setForm((f) => ({ ...f, productId: e.target.value }))
                }
                style={{
                  width: "100%",
                  border: `1px solid ${colors.line}`,
                  borderRadius: 8,
                  padding: 8,
                }}
                placeholder="uuid product"
              />
            </div>
            <div>
              <label>SKU</label>
              <input
                value={form.sku}
                onChange={(e) =>
                  setForm((f) => ({ ...f, sku: e.target.value }))
                }
                style={{
                  width: "100%",
                  border: `1px solid ${colors.line}`,
                  borderRadius: 8,
                  padding: 8,
                }}
                placeholder="SKU (opsional)"
              />
            </div>
            <div>
              <label>Nama</label>
              <input
                value={form.name}
                onChange={(e) =>
                  setForm((f) => ({ ...f, name: e.target.value }))
                }
                style={{
                  width: "100%",
                  border: `1px solid ${colors.line}`,
                  borderRadius: 8,
                  padding: 8,
                }}
                placeholder="nama produk"
              />
            </div>
            <div>
              <label>UOM</label>
              <input
                value={form.uom}
                onChange={(e) =>
                  setForm((f) => ({ ...f, uom: e.target.value }))
                }
                style={{
                  width: "100%",
                  border: `1px solid ${colors.line}`,
                  borderRadius: 8,
                  padding: 8,
                }}
              />
            </div>
            <div>
              <label>Qty</label>
              <input
                type="number"
                min={1}
                value={form.qty}
                onChange={(e) =>
                  setForm((f) => ({ ...f, qty: Number(e.target.value) }))
                }
                style={{
                  width: "100%",
                  border: `1px solid ${colors.line}`,
                  borderRadius: 8,
                  padding: 8,
                }}
              />
            </div>
            <div>
              <label>Harga</label>
              <input
                type="number"
                min={0}
                value={form.price}
                onChange={(e) =>
                  setForm((f) => ({ ...f, price: Number(e.target.value) }))
                }
                style={{
                  width: "100%",
                  border: `1px solid ${colors.line}`,
                  borderRadius: 8,
                  padding: 8,
                }}
              />
            </div>
          </div>

          <div style={{ marginTop: 12 }}>
            <button
              onClick={() => {
                if (!form.productId || !form.name) return;
                addItem({
                  productId: form.productId,
                  sku: form.sku || null,
                  name: form.name,
                  uom: form.uom,
                  qty: form.qty,
                  price: form.price,
                });
              }}
              style={{
                background: `linear-gradient(135deg, ${colors.brandFrom} 0%, ${colors.brandTo} 100%)`,
                color: "white",
                border: "none",
                padding: "8px 14px",
                borderRadius: 10,
                cursor: "pointer",
                fontWeight: 600,
              }}
            >
              Tambah ke Cart
            </button>
          </div>
        </div>

        {/* Kanan: Cart */}
        <div
          style={{
            padding: 12,
            border: `1px solid ${colors.line}`,
            borderRadius: 12,
            background: "white",
          }}
        >
          <CartPanel />
        </div>
      </div>
    </div>
  );
}
