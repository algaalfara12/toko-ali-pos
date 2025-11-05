// packages/api/src/utils/audit.ts
import { FastifyRequest } from "fastify";
import { prisma } from "../prisma";

export type AuditAction =
  | "SALE"
  | "RETURN"
  | "PURCHASE"
  | "TRANSFER"
  | "ADJUSTMENT";

interface AuditParams {
  action: AuditAction;
  entityType: string;
  entityId: string;
  refNumber?: string | null;
  payload?: any;
}

/** Helper: mask string (default: tampilkan 2 digit terakhir). */
function maskTail(str: string, visibleTail: number = 2): string {
  if (!str) return str;
  const s = String(str);
  if (s.length <= visibleTail) return "*".repeat(s.length);
  return "*".repeat(s.length - visibleTail) + s.slice(-visibleTail);
}

/** Redaksi data sensitif secara rekursif */
function redactSensitive(input: any): any {
  const SENSITIVE_KEYS = new Set(["password", "pin", "card", "phone"]);
  if (input == null) return input;

  if (Array.isArray(input)) {
    return input.map((v) => redactSensitive(v));
  }
  if (typeof input === "object") {
    const out: any = {};
    for (const [k, v] of Object.entries(input)) {
      if (SENSITIVE_KEYS.has(k.toLowerCase())) {
        // Khusus phone/card/pin: mask tail
        if (typeof v === "string" || typeof v === "number") {
          out[k] = maskTail(String(v), 2);
        } else {
          out[k] = "***";
        }
      } else {
        out[k] = redactSensitive(v);
      }
    }
    return out;
  }
  return input;
}

/**
 * Menulis 1 baris audit — fail-safe (tidak memblok transaksi utama).
 * Redaksi dilakukan SAAT SIMPAN.
 */
export async function audit(req: FastifyRequest, p: AuditParams) {
  try {
    const user = (req as any).user as
      | { id: string; username: string; role: string }
      | undefined;

    const redacted = redactSensitive(p.payload ?? {});

    await prisma.auditLog.create({
      data: {
        action: p.action as any,
        actorId: user?.id ?? "anonymous",
        actorUsername: user?.username ?? "anonymous",
        entityType: p.entityType,
        entityId: p.entityId,
        refNumber: p.refNumber ?? null,
        ip: (req.ip ?? null) as any,
        payload: redacted,
      },
    });
  } catch (err) {
    // Jangan pernah lempar error ke caller — jangan memblok transaksi utama
    (req as any).log?.error?.({ err }, "audit-log failed");
  }
}

// Optional: export juga redactSensitive untuk masking on-the-fly saat baca
export const _internalRedact = { redactSensitive, maskTail };

/* ===========================
   RETENTION (opsional #3)
   =========================== */

/** Baca hari retensi dari ENV, default 90. Nilai < 0 akan dianggap 90. */
export function getRetentionDays(): number {
  const raw = process.env.AUDIT_RETENTION_DAYS;
  const n = raw ? parseInt(raw, 10) : 90;
  if (!Number.isFinite(n) || n < 0) return 90;
  return n;
}

/** Hitung cutoff date: now - (days * 24h) */
export function getRetentionCutoff(days?: number): Date {
  const d = typeof days === "number" ? days : getRetentionDays();
  const ms = d * 24 * 60 * 60 * 1000;
  return new Date(Date.now() - ms);
}

/** Hitung berapa log yang akan kena (createdAt < cutoff) */
export async function countOldAuditLogs(days?: number): Promise<number> {
  const cutoff = getRetentionCutoff(days);
  const cnt = await prisma.auditLog.count({
    where: { createdAt: { lt: cutoff } },
  });
  return cnt;
}

/**
 * Hapus audit log lama.
 * @param params.days override hari; jika tidak diisi → pakai ENV.
 * @param params.dryRun bila true → tidak menghapus, hanya hitung (affected).
 */
export async function purgeOldAuditLogs(params?: {
  days?: number;
  dryRun?: boolean;
}): Promise<{
  ok: true;
  days: number;
  cutoff: string;
  affected: number;
  deleted: number;
  dryRun: boolean;
}> {
  const days = params?.days ?? getRetentionDays();
  const cutoff = getRetentionCutoff(days);
  const dryRun = !!params?.dryRun;

  const affected = await prisma.auditLog.count({
    where: { createdAt: { lt: cutoff } },
  });

  let deleted = 0;
  if (!dryRun && affected > 0) {
    const res = await prisma.auditLog.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    deleted = res.count ?? 0;
  }

  return {
    ok: true,
    days,
    cutoff: cutoff.toISOString(),
    affected,
    deleted,
    dryRun,
  };
}
