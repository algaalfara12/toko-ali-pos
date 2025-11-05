// packages/api/src/plugins/tombstoneRetention.ts
import { FastifyInstance } from "fastify";
import { prisma } from "../prisma";
import { loadEnv } from "../config/env";

type RunOptions = {
  ttlDays?: number;
  staleDays?: number;
  safetySec?: number;
  now?: Date;
};

export default async function tombstoneRetentionPlugin(app: FastifyInstance) {
  const env = loadEnv();

  async function runOnce(opt?: RunOptions) {
    const now = opt?.now ?? new Date();
    const ttlDays =
      typeof opt?.ttlDays === "number"
        ? opt!.ttlDays
        : env.TOMBSTONE_RETENTION_DAYS;
    const safetySec =
      typeof opt?.safetySec === "number"
        ? opt!.safetySec
        : env.TOMBSTONE_RETENTION_SAFETY_SEC;

    // Catatan: staleDays disediakan untuk masa depan (cek device yang belum sync).
    // Untuk uji cepat kita fokus threshold (TTL + safety).
    const threshold = new Date(
      now.getTime() - ttlDays * 86400000 - safetySec * 1000
    );

    const delRes = await prisma.tombstone.deleteMany({
      where: {
        deletedAt: { lte: threshold },
      },
    });

    return {
      ok: true,
      deleted: delRes.count,
      threshold: threshold.toISOString(),
    };
  }

  // Endpoint manual (GET dan POST) agar mudah diuji tanpa restart server
  app.get("/_jobs/run-tombstone-retention", async (req, reply) => {
    const q = req.query as any;
    const ttlDays = q?.ttlDays !== undefined ? Number(q.ttlDays) : undefined;
    const staleDays =
      q?.staleDays !== undefined ? Number(q.staleDays) : undefined;
    const safetySec =
      q?.safetySec !== undefined ? Number(q.safetySec) : undefined;
    const res = await runOnce({ ttlDays, staleDays, safetySec });
    return reply.send(res);
  });

  app.post("/_jobs/run-tombstone-retention", async (req, reply) => {
    const q = req.query as any;
    const ttlDays = q?.ttlDays !== undefined ? Number(q.ttlDays) : undefined;
    const staleDays =
      q?.staleDays !== undefined ? Number(q.staleDays) : undefined;
    const safetySec =
      q?.safetySec !== undefined ? Number(q.safetySec) : undefined;
    const res = await runOnce({ ttlDays, staleDays, safetySec });
    return reply.send(res);
  });

  if (env.TOMBSTONE_RETENTION_ENABLED) {
    const interval = env.TOMBSTONE_RETENTION_INTERVAL_MS;
    app.log.info({ interval }, "tombstone-retention: job scheduled");
    setInterval(() => {
      runOnce().catch((err) => {
        app.log.error({ err }, "tombstone-retention: job failed");
      });
    }, interval);
  } else {
    app.log.info("tombstone-retention: disabled by env");
  }
}
