"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { z } from "zod";
import { loginApi, fetchMe } from "@/utils/auth-api";
import { useAuth } from "@/store/auth";

/** ================= Icons (inline SVG) ================= */
function IconShop({ size = 28, color = "#2563eb" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path
        d="M3 7h18l-1 10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2L3 7z"
        stroke={color}
        strokeWidth="1.5"
      />
      <path
        d="M7 7V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v2"
        stroke={color}
        strokeWidth="1.5"
      />
    </svg>
  );
}
function IconUser({ size = 18, color = "#64748b" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="8" r="4" stroke={color} strokeWidth="1.5" />
      <path
        d="M4 20a8 8 0 0 1 16 0"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
function IconLock({ size = 18, color = "#64748b" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <rect
        x="4"
        y="10"
        width="16"
        height="10"
        rx="2"
        stroke={color}
        strokeWidth="1.5"
      />
      <path
        d="M8 10V8a4 4 0 1 1 8 0v2"
        stroke={color}
        strokeWidth="1.5"
      />
    </svg>
  );
}
function IconEye({ size = 18, color = "#2563eb" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path
        d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"
        stroke={color}
        strokeWidth="1.5"
      />
      <circle cx="12" cy="12" r="3" stroke={color} strokeWidth="1.5" />
    </svg>
  );
}
function IconEyeOff({ size = 18, color = "#2563eb" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path
        d="M3 3l18 18"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M2 12s3.5-7 10-7c2.12 0 3.99.52 5.57 1.33M22 12s-3.5 7-10 7c-2.12 0-3.99-.52-5.57-1.33"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx="12" cy="12" r="3" stroke={color} strokeWidth="1.5" />
    </svg>
  );
}
function IconError({ size = 20, color = "#ef4444" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke={color} strokeWidth="1.5" />
      <path d="M12 7v6" stroke={color} strokeWidth="1.5" />
      <circle cx="12" cy="17" r="1" fill={color} />
    </svg>
  );
}
/** ===================================================== */

const LoginSchema = z.object({
  username: z.string().min(3, "Minimal 3 karakter"),
  password: z.string().min(3, "Minimal 3 karakter"),
});

export default function LoginPage() {
  const router = useRouter();
  const setToken = useAuth((s) => s.setToken);
  const setUser = useAuth((s) => s.setUser);

  const [form, setForm] = useState({ username: "", password: "" });
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showPopup, setShowPopup] = useState(false);
  const [showPwd, setShowPwd] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);

    const v = LoginSchema.safeParse(form);
    if (!v.success) {
      setErr(v.error.issues.map((i) => i.message).join(", "));
      setShowPopup(true);
      return;
    }

    setLoading(true);
    try {
      const { token } = await loginApi(form.username, form.password);
      setToken(token, true);

      const me = await fetchMe(token);
      setUser(me.user);

      switch (me.user.role) {
        case "admin":
          router.replace("/admin");
          break;
        case "kasir":
          router.replace("/kasir");
          break;
        case "petugas_gudang":
          router.replace("/gudang");
          break;
        default:
          router.replace("/");
      }
    } catch (e: any) {
      setErr(e?.message || "Login gagal");
      setShowPopup(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        // Gradient silver + bluish
        background:
          "linear-gradient(135deg, #e6ebf2 0%, #cfd8e3 40%, #bfd2f3 100%)",
        color: "black",
      }}
    >
      {/* Card */}
      <div
        style={{
          width: 420,
          maxWidth: "95vw",
          background: "white",
          borderRadius: 14,
          boxShadow:
            "0 12px 30px rgba(0,0,0,0.15), 0 3px 6px rgba(0,0,0,0.1)",
          padding: "22px 24px",
          border: "1px solid #e5e7eb",
        }}
      >
        {/* Header brand */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginBottom: 14,
          }}
        >
          <div
            style={{
              background:
                "linear-gradient(135deg, #2563eb 0%, #0ea5e9 100%)",
              borderRadius: 12,
              width: 44,
              height: 44,
              display: "grid",
              placeItems: "center",
            }}
          >
            <IconShop size={26} color="#ffffff" />
          </div>
          <div>
            <div
              style={{
                fontSize: 18,
                fontWeight: 600,
                letterSpacing: 0.2,
                color: "#111827",
              }}
            >
              TOKO ALI — Login
            </div>
            <div style={{ fontSize: 12, color: "#6b7280" }}>
              Silakan masuk untuk melanjutkan
            </div>
          </div>
        </div>

        {/* Form */}
        <form onSubmit={onSubmit}>
          {/* Username */}
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 12, color: "#374151" }}>Username</label>
            <div style={{ position: "relative", marginTop: 6 }}>
              <div
                style={{
                  position: "absolute",
                  insetInlineStart: 10,
                  top: "50%",
                  transform: "translateY(-50%)",
                  pointerEvents: "none",
                }}
              >
                <IconUser />
              </div>
              <input
                type="text"
                value={form.username}
                onChange={(e) =>
                  setForm((f) => ({ ...f, username: e.target.value }))
                }
                autoFocus
                placeholder="Masukkan username"
                style={{
                  width: "100%",
                  padding: "10px 12px 10px 36px",
                  borderRadius: 8,
                  border: "1px solid #d1d5db",
                  outline: "none",
                  fontSize: 14,
                  color: "#111827",
                }}
                onFocus={(e) => (e.currentTarget.style.borderColor = "#60a5fa")}
                onBlur={(e) =>
                  (e.currentTarget.style.borderColor = "#d1d5db")
                }
              />
            </div>
          </div>
          {/* Password */}
          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 12, color: "#374151" }}>Password</label>
            <div style={{ position: "relative", marginTop: 6 }}>
              <div
                style={{
                  position: "absolute",
                  insetInlineStart: 10,
                  top: "50%",
                  transform: "translateY(-50%)",
                  pointerEvents: "none",
                }}
              >
                <IconLock />
              </div>
              <input
                type={showPwd ? "text" : "password"}
                value={form.password}
                onChange={(e) =>
                  setForm((f) => ({ ...f, password: e.target.value }))
                }
                placeholder="Masukkan password"
                style={{
                  width: "100%",
                  padding: "10px 40px 10px 36px",
                  borderRadius: 8,
                  border: "1px solid #d1d5db",
                  outline: "none",
                  fontSize: 14,
                  color: "#111827",
                }}
                onFocus={(e) => (e.currentTarget.style.borderColor = "#60a5fa")}
                onBlur={(e) =>
                  (e.currentTarget.style.borderColor = "#d1d5db")
                }
              />
              <button
                type="button"
                onClick={() => setShowPwd((s) => !s)}
                aria-label={showPwd ? "Sembunyikan password" : "Tampilkan password"}
                style={{
                  position: "absolute",
                  insetInlineEnd: 8,
                  top: "50%",
                  transform: "translateY(-50%)",
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  padding: 6,
                  borderRadius: 6,
                }}
              >
                {showPwd ? <IconEyeOff /> : <IconEye />}
              </button>
            </div>
          </div>

          {/* Button Submit */}
          <button
            type="submit"
            disabled={loading}
            style={{
              width: "100%",
              padding: "10px 14px",
              borderRadius: 10,
              border: "none",
              cursor: "pointer",
              color: "white",
              fontWeight: 600,
              letterSpacing: 0.3,
              transition: "all 0.2s ease",
              // gradient primary
              background:
                "linear-gradient(135deg, #2563eb 0%, #0ea5e9 100%)",
              boxShadow: "0 6px 18px rgba(37,99,235,0.25)",
            }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.boxShadow =
                "0 8px 22px rgba(37,99,235,0.35)")
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.boxShadow =
                "0 6px 18px rgba(37,99,235,0.25)")
            }
          >
            {loading ? "Logging in..." : "Login"}
          </button>
        </form>
      </div>

      {/* Popup Error */}
      {showPopup && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
        >
          <div
            style={{
              background: "white",
              width: 360,
              maxWidth: "95vw",
              borderRadius: 12,
              boxShadow:
                "0 10px 28px rgba(0,0,0,0.2), 0 2px 8px rgba(0,0,0,0.15)",
              padding: 18,
              textAlign: "center",
              border: "1px solid #f3f4f6",
            }}
          >
            <div style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "center" }}>
              <IconError />
              <h3 style={{ margin: 0, color: "#ef4444", fontWeight: 700 }}>
                Login Gagal
              </h3>
            </div>
            <p style={{ marginTop: 10, marginBottom: 16, color: "#374151" }}>
              {"Periksa kembali username dan password Anda."}
            </p>
            <button
              onClick={() => {
                setShowPopup(false);
                setErr(null);
                // tidak mengosongkan form supaya user bisa koreksi
              }}
              style={{
                background: "linear-gradient(135deg, #2563eb 0%, #0ea5e9 100%)",
                color: "white",
                border: "none",
                padding: "8px 16px",
                borderRadius: 8,
                cursor: "pointer",
                fontWeight: 600,
              }}
            >
              OK
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
