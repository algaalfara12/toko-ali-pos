import "@fastify/jwt";
declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: {
      id: string;
      username: string;
      role: "admin" | "kasir" | "petugas_gudang";
    };
    user: {
      id: string;
      username: string;
      role: "admin" | "kasir" | "petugas_gudang";
    };
  }
}
