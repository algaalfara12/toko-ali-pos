// packages/api/src/routes/auditLogs.ts
import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../prisma";
import { requireRoles } from "../utils/roleGuard";
import {
  _internalRedact,
  getRetentionDays,
  getRetentionCutoff,
  purgeOldAuditLogs,
  countOldAuditLogs,
} from "../utils/audit";
import { toCsv, sendCsv } from "../utils/csv";

export default async function auditLogsRoutes(app: FastifyInstance) {
  // LIST + CSV
  app.get(
    "/admin/audit-logs",
    { preHandler: [requireRoles(app, ["admin"])] },
    async (req, reply) => {
      const Q = z.object({
        from: z.string().optional(),
        to: z.string().optional(),
        action: z
          .enum(["SALE", "RETURN", "PURCHASE", "TRANSFER", "ADJUSTMENT"])
          .optional(),
        actorId: z.string().uuid().optional(),
        entityType: z.string().optional(),
        q: z.string().optional(),
        page: z.coerce.number().int().positive().optional().default(1),
        pageSize: z.coerce
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .default(20),
        export: z.string().optional(), // csv
      });

      const p = Q.safeParse(req.query);
      if (!p.success) {
        return reply.code(400).send({ ok: false, error: p.error.flatten() });
      }
      const {
        from,
        to,
        action,
        actorId,
        entityType,
        q,
        page,
        pageSize,
        export: exportFmt,
      } = p.data;

      let df: Date | undefined, dt: Date | undefined;
      if (from) df = new Date(from + "T00:00:00");
      if (to) dt = new Date(to + "T23:59:59.999");

      const where: any = {
        ...(action ? { action } : {}),
        ...(actorId ? { actorId } : {}),
        ...(entityType ? { entityType } : {}),
        ...(df && dt
          ? { createdAt: { gte: df, lte: dt } }
          : df
          ? { createdAt: { gte: df } }
          : dt
          ? { createdAt: { lte: dt } }
          : {}),
        ...(q ? { refNumber: { contains: q } } : {}),
      };

      const skip = (page - 1) * pageSize;

      const [total, rows] = await Promise.all([
        prisma.auditLog.count({ where }),
        prisma.auditLog.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip,
          take: pageSize,
        }),
      ]);

      // Masking on-the-fly (defense in depth, juga melindungi log lama)
      const redactedRows = rows.map((r) => ({
        ...r,
        payload: _internalRedact.redactSensitive(r.payload ?? {}),
      }));

      if ((exportFmt ?? "").toLowerCase() === "csv") {
        const headers = [
          "id",
          "action",
          "actorId",
          "actorUsername",
          "entityType",
          "entityId",
          "refNumber",
          "ip",
          "createdAt",
        ];
        const csvRows = redactedRows.map((r) => ({
          id: r.id,
          action: r.action,
          actorId: r.actorId,
          actorUsername: r.actorUsername,
          entityType: r.entityType,
          entityId: r.entityId,
          refNumber: r.refNumber ?? "",
          ip: r.ip ?? "",
          createdAt: r.createdAt.toISOString(),
        }));
        const csv = toCsv(headers, csvRows);
        return sendCsv(reply, `audit_${from ?? ""}_${to ?? ""}.csv`, csv);
      }

      return reply.send({
        ok: true,
        page,
        pageSize,
        total,
        data: redactedRows,
      });
    }
  );

  // DETAIL (masked)
  app.get(
    "/admin/audit-logs/:id",
    { preHandler: [requireRoles(app, ["admin"])] },
    async (req, reply) => {
      const { id } = req.params as any;
      const row = await prisma.auditLog.findUnique({
        where: { id: String(id) },
      });
      if (!row) return reply.code(404).send({ ok: false, error: "Not found" });

      // Masking on-the-fly juga di detail
      const redacted = {
        ...row,
        payload: _internalRedact.redactSensitive(row.payload ?? {}),
      };
      return reply.send({ ok: true, data: redacted });
    }
  );

  /* ===========================
     RETENTION (opsional #3)
     =========================== */

  // PREVIEW berapa log yang akan terhapus (tanpa menghapus)
  app.get(
    "/admin/audit-logs/retention/preview",
    { preHandler: [requireRoles(app, ["admin"])] },
    async (req, reply) => {
      const Q = z.object({
        days: z.coerce.number().int().min(0).optional(), // override pengujian
      });
      const p = Q.safeParse(req.query);
      if (!p.success) {
        return reply.code(400).send({ ok: false, error: p.error.flatten() });
      }
      const days =
        typeof p.data.days === "number" ? p.data.days : getRetentionDays();
      const cutoff = getRetentionCutoff(days);

      const affected = await countOldAuditLogs(days);
      return reply.send({
        ok: true,
        days,
        cutoff: cutoff.toISOString(),
        affected,
      });
    }
  );

  // CLEANUP — hapus log lama. Body { days?: number; dryRun?: boolean }
  app.post(
    "/admin/audit-logs/retention/cleanup",
    { preHandler: [requireRoles(app, ["admin"])] },
    async (req, reply) => {
      const Q = z.object({
        days: z.coerce.number().int().min(0).optional(),
        dryRun: z.coerce.boolean().optional().default(false),
      });
      const p = Q.safeParse(req.body);
      if (!p.success) {
        return reply.code(400).send({ ok: false, error: p.error.flatten() });
      }

      const result = await purgeOldAuditLogs({
        days: p.data.days,
        dryRun: p.data.dryRun,
      });
      return reply.send(result);
    }
  );
}
