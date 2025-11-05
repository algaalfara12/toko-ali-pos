// packages/api/src/server.ts
import dotenv from "dotenv";
dotenv.config();

import { loadEnv } from "./config/env";
import { buildApp } from "./app";

async function main() {
  const env = loadEnv();
  const app = await buildApp();

  // (opsional) log status trustProxy saat boot
  app.log.info({ trustProxy: env.TRUST_PROXY }, "boot trustProxy status");

  const PORT = env.PORT ? Number(env.PORT) : 3001;
  await app

    .listen({ port: PORT, host: "127.0.0.1" })
    .then(() => app.log.info({ port: PORT }, "API running"))
    .catch((err) => {
      app.log.error(err);
      process.exit(1);
    });
}

main();
