"use client";
import { useCart } from "@/store/cart";
import { colors } from "@/theme";

export default function CartPanel() {
  const items = useCart((s) => s.items);
  const removeIndex = useCart((s) => s.removeIndex);
  const setQty = useCart((s) => s.setQty);
  const total = useCart((s) => s.total)();

  return (
    <div>
      <h3 style={{ marginBottom: 10, color: colors.textDark }}>Keranjang</h3>
      <div style={{ borderTop: `1px solid ${colors.line}`, paddingTop: 10 }}>
        {items.length === 0 && (
          <div style={{ color: colors.textMuted }}>Belum ada item.</div>
        )}
        {items.map((it, idx) => (
          <div
            key={idx}
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 100px 80px 100px 80px",
              gap: 8,
              alignItems: "center",
              padding: "8px 0",
              borderBottom: `1px dashed ${colors.line}`,
            }}
          >
            <div>
              <div style={{ fontWeight: 600 }}>{it.name}</div>
              <div style={{ fontSize: 12, color: colors.textMuted }}>
                {it.sku ? `[${it.sku}]` : ""} — {it.uom}
              </div>
            </div>

            <div style={{ textAlign: "right" }}>
              {it.price.toLocaleString("id-ID")}
            </div>

            <div>
              <input
                type="number"
                value={it.qty}
                onChange={(e) => setQty(idx, Number(e.target.value))}
                min={0}
                style={{
                  width: "100%",
                  border: `1px solid ${colors.line}`,
                  borderRadius: 8,
                  padding: "6px 8px",
                }}
              />
            </div>

            <div style={{ textAlign: "right", fontWeight: 600 }}>
              {it.subtotal.toLocaleString("id-ID")}
            </div>

            <div>
              <button
                onClick={() => removeIndex(idx)}
                style={{
                  background: "#ef4444",
                  color: "white",
                  border: "none",
                  padding: "6px 10px",
                  borderRadius: 8,
                  cursor: "pointer",
                }}
              >
                Hapus
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Total */}
      <div
        style={{
          marginTop: 12,
          textAlign: "right",
          fontSize: 16,
          fontWeight: 700,
        }}
      >
        Total: {total.toLocaleString("id-ID")}
      </div>
    </div>
  );
}
