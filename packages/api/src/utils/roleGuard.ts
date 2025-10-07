import { FastifyInstance } from 'fastify';

export function requireRoles(app: FastifyInstance, roles: string[]) {
  return async function (req: any, reply: any) {
    await app.authenticate(req, reply); // set req.user
    const user = req.user as { id: string; role: string; username?: string };
    if (!user || !roles.includes(user.role)) {
      return reply.code(403).send({ ok: false, error: 'Forbidden' });
    }
  };
}
