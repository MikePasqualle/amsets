import { cors } from "hono/cors";

export const corsMiddleware = cors({
  origin: [
    "http://localhost:3000",
    "https://amsets.xyz",
    "https://www.amsets.xyz",
  ],
  allowHeaders: [
    "Content-Type",
    "Authorization",
    "X-Content-Token",
    "X-Admin-Secret",
  ],
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  credentials: true,
});
