// packages/api/src/plugins/logging.ts
import { FastifyInstance, FastifyPluginAsync } from "fastify";

const loggingPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.addHook("onRequest", async (req) => {
    (req as any)._startNs = process.hrtime.bigint();
    // pakai req.id dari @fastify/request-id
    try {
      if ((req.log as any).child) {
        (req as any).log = req.log.child({ reqId: String(req.id) });
      }
    } catch {}
  });

  app.addHook("onResponse", async (req, reply) => {
    try {
      const startNs = (req as any)._startNs as bigint | undefined;
      const durMs =
        startNs != null
          ? Number(process.hrtime.bigint() - startNs) / 1_000_000
          : undefined;

      req.log.info(
        {
          method: req.method,
          url: req.url,
          statusCode: reply.statusCode,
          durationMs: durMs != null ? Math.round(durMs * 10) / 10 : undefined,
        },
        "request completed"
      );
    } catch (e) {
      try {
        req.log.error({ err: e }, "failed to log onResponse");
      } catch {}
    }
  });

  // error handler global sudah di plugins/errors.ts
};

export default loggingPlugin;
