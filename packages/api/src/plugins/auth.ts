import fp from 'fastify-plugin';
import fastifyJwt from '@fastify/jwt';
import bcrypt from 'bcryptjs';

export default fp(async (app) => {
  app.register(fastifyJwt, {
    secret: process.env.JWT_SECRET || 'dev-secret',
  });

  // verify JWT (dipakai di preHandler)
  app.decorate('authenticate', async function (request, reply) {
    try {
      await request.jwtVerify();
    } catch {
      reply.code(401).send({ ok: false, error: 'Unauthorized' });
    }
  });

  // util hash/compare password
  app.decorate('hashPassword', async (plain: string) => {
    const saltRounds = 10;
    return bcrypt.hash(plain, saltRounds);
  });

  app.decorate('comparePassword', async (plain: string, hash: string) => {
    return bcrypt.compare(plain, hash);
  });
});

// Type augmentations
declare module 'fastify' {
  interface FastifyInstance {
    authenticate: any;
    hashPassword(plain: string): Promise<string>;
    comparePassword(plain: string, hash: string): Promise<boolean>;
  }
  interface FastifyRequest {
    user: { id: string; role: string; username: string };
  }
}
