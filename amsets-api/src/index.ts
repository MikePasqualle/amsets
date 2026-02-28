import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { corsMiddleware } from "./middleware/cors.middleware";
import { authRouter } from "./routes/auth.route";
import { marketplaceRouter } from "./routes/marketplace.route";
import { contentRouter } from "./routes/content.route";
import { uploadRouter } from "./routes/upload.route";
import { purchasesRouter } from "./routes/purchases.route";
import { webhookRouter } from "./routes/webhook.route";
import { adminRouter } from "./routes/admin.route";
import { listingsRouter } from "./routes/listings.route";
import { connectRedis } from "./db/redis";

const app = new Hono();

// ─── Global middleware ────────────────────────────────────────────────────────
app.use("*", corsMiddleware);
app.use("*", logger());

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (c) => c.json({ status: "ok", timestamp: Date.now() }));

// ─── API routes ───────────────────────────────────────────────────────────────
app.route("/api/v1/auth", authRouter);
app.route("/api/v1/marketplace", marketplaceRouter);
app.route("/api/v1/content", contentRouter);
app.route("/api/v1/upload", uploadRouter);
app.route("/api/v1/purchases", purchasesRouter);
app.route("/api/v1/webhook", webhookRouter);
app.route("/api/v1/admin", adminRouter);
app.route("/api/v1/listings", listingsRouter);

// ─── 404 fallback ─────────────────────────────────────────────────────────────
app.notFound((c) => c.json({ error: "Not found" }, 404));

// ─── Error handler ─────────────────────────────────────────────────────────────
app.onError((err, c) => {
  console.error("[API Error]", err);
  return c.json({ error: "Internal server error" }, 500);
});

// ─── Start server ─────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT ?? "3001", 10);

async function start() {
  await connectRedis();

  serve({ fetch: app.fetch, port: PORT }, () => {
    console.log(`\n🚀 AMSETS API running on http://localhost:${PORT}`);
    console.log(`   Health: http://localhost:${PORT}/health`);
    console.log(`   Marketplace: http://localhost:${PORT}/api/v1/marketplace`);
    console.log(`   Purchases:   http://localhost:${PORT}/api/v1/purchases`);
    console.log(`   Webhook:     http://localhost:${PORT}/api/v1/webhook/helius`);
  });
}

start().catch(console.error);

export default app;
