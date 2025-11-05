import { z, ZodSchema } from "zod";
import { FastifyRequest } from "fastify";

/** Validasi body request */
export async function validateBody<T extends ZodSchema>(
  req: FastifyRequest,
  schema: T
): Promise<z.infer<T>> {
  const parsed = schema.safeParse((req.body as any) ?? {});
  if (!parsed.success) {
    // throw biar tertangkap oleh errorsPlugin
    throw parsed.error;
  }
  return parsed.data;
}

/** Validasi query params */
export async function validateQuery<T extends ZodSchema>(
  req: FastifyRequest,
  schema: T
): Promise<z.infer<T>> {
  const parsed = schema.safeParse((req.query as any) ?? {});
  if (!parsed.success) {
    throw parsed.error;
  }
  return parsed.data;
}

/** Validasi params (path parameter) */
export async function validateParams<T extends ZodSchema>(
  req: FastifyRequest,
  schema: T
): Promise<z.infer<T>> {
  const parsed = schema.safeParse((req.params as any) ?? {});
  if (!parsed.success) {
    throw parsed.error;
  }
  return parsed.data;
}
