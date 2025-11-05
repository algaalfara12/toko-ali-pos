import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";

/**
 * Pastikan setiap response membawa header `x-request-id`.
 * - ID diambil dari `req.id` (sudah diisi oleh genReqId di server.ts).
 * - Dipasang di hook `onSend` supaya berlaku untuk *semua* response,
 *   termasuk error yang ditangani oleh plugin errors.
 */
export default fp(async function requestIdHeader(app: FastifyInstance) {
  app.addHook("onSend", async (req, reply, payload) => {
    if (!reply.getHeader("x-request-id")) {
      reply.header("x-request-id", String(req.id));
    }
    return payload;
  });
});
