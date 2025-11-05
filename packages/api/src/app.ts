// packages/api/src/app.ts
import Fastify from "fastify";
import fastifyJwt from "@fastify/jwt";
import { randomUUID } from "crypto";

import { loadEnv } from "./config/env";

// Plugins
import requestIdHeader from "./plugins/requestIdHeader";
import loggingPlugin from "./plugins/logging";
import errorsPlugin from "./plugins/errors";
import securityPlugin from "./plugins/security";
import tombstoneRetentionPlugin from "./plugins/tombstoneRetention";

// Routes (tetap sama seperti server.ts kamu)
import authPlugin from "./plugins/auth";
import productRoutes from "./routes/products";
import stockRoutes from "./routes/stock";
import salesRoutes from "./routes/sales";
import reportsRoutes from "./routes/reports";
import repackRoutes from "./routes/repack";
import purchasesRoutes from "./routes/purchases";
import posRoutes from "./routes/pos";
import posHoldRoutes from "./routes/posHold";
import posReturnRoutes from "./routes/posReturn";
import reportsTransfersRoutes from "./routes/reportsTransfers";
import reportsReturnsRoutes from "./routes/reportsReturns";
import customersRoutes from "./routes/customers";
import topCustomersRoutes from "./routes/reportsTopCustomers";
import locationsRoutes from "./routes/locations";
import productUomsRoutes from "./routes/productUoms";
import pricesRoutes from "./routes/prices";
import auditLogsRoutes from "./routes/auditLogs";
import closeDayRoutes from "./routes/closeDay";
import salesReceiptRoutes from "./routes/salesReceipt";
import adminStoreProfileRoutes from "./routes/adminStoreProfile";
import usersRoutes from "./routes/users";
import reportsMembersRoutes from "./routes/reportsMember";
import purchaseOrdersRoutes from "./routes/purchaseOrders";
import reportsStockRoutes from "./routes/reportsStock";
import syncRoutes from "./routes/sync";
import syncSalesRoutes from "./routes/syncSales";
import syncReturnsRoutes from "./routes/syncReturns";
import syncInventoryRoutes from "./routes/syncInventory";
import syncStockRoutes from "./routes/syncStock";
import reportsAdjustRoutes from "./routes/reportsAdjust";
import authRoutes from "./routes/auth";

export async function buildApp() {
  const env = loadEnv();

  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      base: { app: "toko-ali-pos-api" },
    },
    genReqId: (req) => {
      const h =
        (req.headers["x-request-id"] as string) ||
        (req.headers["x-correlation-id"] as string);
      return h && h.trim() ? h.trim() : randomUUID();
    },
    bodyLimit: env.BODY_LIMIT,
    trustProxy: env.TRUST_PROXY,
  });

  // Header x-request-id untuk semua response
  app.register(requestIdHeader);

  // JWT
  app.register(fastifyJwt, {
    secret: env.JWT_SECRET,
    sign: {
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      expiresIn: env.JWT_EXPIRES,
    },
    verify: {
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    },
  });

  // Plugins umum
  app.register(loggingPlugin);
  app.register(securityPlugin);
  app.register(errorsPlugin);
  app.register(tombstoneRetentionPlugin);

  app.get("/health", async () => ({ ok: true }));

  app.register(authPlugin);
  app.register(authRoutes);
  app.register(productRoutes);
  app.register(stockRoutes);
  app.register(salesRoutes);
  app.register(reportsRoutes);
  app.register(repackRoutes);
  app.register(purchasesRoutes);
  app.register(posRoutes);
  app.register(posHoldRoutes);
  app.register(posReturnRoutes);
  app.register(reportsTransfersRoutes);
  app.register(reportsReturnsRoutes);
  app.register(customersRoutes);
  app.register(topCustomersRoutes);
  app.register(productUomsRoutes);
  app.register(pricesRoutes);
  app.register(locationsRoutes);
  app.register(auditLogsRoutes);
  app.register(closeDayRoutes);
  app.register(salesReceiptRoutes);
  app.register(adminStoreProfileRoutes);
  app.register(usersRoutes);
  app.register(reportsMembersRoutes);
  app.register(purchaseOrdersRoutes);
  app.register(reportsStockRoutes);
  app.register(syncRoutes);
  app.register(syncSalesRoutes);
  app.register(syncReturnsRoutes);
  app.register(syncInventoryRoutes);
  app.register(syncStockRoutes);
  app.register(reportsAdjustRoutes);

  return app;
}
