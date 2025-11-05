// packages/api/src/utils/roleGuard.ts
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export type Role = "admin" | "kasir" | "petugas_gudang";

export function requireRoles(app: FastifyInstance, roles: Role[]) {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    try {
      const auth = req.headers.authorization;
      if (!auth?.startsWith("Bearer ")) {
        return reply
          .code(401)
          .send({ ok: false, error: "Missing Bearer token" });
      }
      const token = auth.slice(7);
      const payload = await app.jwt.verify(token); // issuer/audience/expiry sudah terkonfigurasi di server.ts

      // Pastikan payload minimal punya {id, username, role}
      const user = payload as any;
      if (!user?.id || !user?.role) {
        return reply
          .code(401)
          .send({ ok: false, error: "Invalid token payload" });
      }
      (req as any).user = user;

      // Cek role
      if (!roles.includes(user.role)) {
        return reply.code(403).send({ ok: false, error: "Forbidden" });
      }
    } catch (e: any) {
      // Pesan lebih informatif untuk token expired
      const msg = e?.message?.toLowerCase().includes("expired")
        ? "Token expired"
        : "Invalid token";
      return reply.code(401).send({ ok: false, error: msg });
    }
  };
}
