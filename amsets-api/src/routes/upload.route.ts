import { Hono } from "hono";
import { verifyUserJwt } from "../services/jwt.service";

const uploadRouter = new Hono();

// ─── POST /api/v1/upload/preview ─────────────────────────────────────────────
// Proxies a preview image to Pinata IPFS server-side (avoids browser CORS).
// Returns { cid, uri } on success.
//
// Why server-side: Pinata Scoped Keys are designed for server use only.
// Browser CORS requests are blocked by Pinata for scoped keys.
//
uploadRouter.post("/preview", async (c) => {
  // Require auth token — only registered users can upload previews
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    verifyUserJwt(authHeader.replace("Bearer ", ""));
  } catch {
    return c.json({ error: "Invalid or expired token" }, 401);
  }

  const jwt = process.env.PINATA_JWT;
  if (!jwt) {
    return c.json({ error: "Pinata not configured on server" }, 503);
  }

  // Parse the incoming multipart form data
  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    return c.json({ error: "Invalid multipart form data" }, 400);
  }

  const file = formData.get("file");
  if (!file || typeof file === "string") {
    return c.json({ error: "Missing file field" }, 400);
  }

  const name = (formData.get("name") as string | null) ?? "amsets-preview";

  // Forward to Pinata
  const pinataForm = new FormData();
  pinataForm.append("file", file);
  pinataForm.append("pinataMetadata", JSON.stringify({ name }));

  const pinataRes = await fetch(
    "https://api.pinata.cloud/pinning/pinFileToIPFS",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}` },
      body: pinataForm,
    }
  );

  if (!pinataRes.ok) {
    const errText = await pinataRes.text().catch(() => "");
    console.error("[upload/preview] Pinata error:", pinataRes.status, errText);

    // Parse Pinata error to return a clean human-readable message
    let reason = `HTTP ${pinataRes.status}`;
    try {
      const parsed = JSON.parse(errText);
      const detail = parsed?.error?.details ?? parsed?.error?.reason ?? parsed?.error ?? parsed?.message;
      if (typeof detail === "string") reason = detail;
    } catch {
      if (errText) reason = errText.slice(0, 200);
    }

    // Map known Pinata error reasons to user-friendly messages
    if (pinataRes.status === 403 || reason.toLowerCase().includes("plan") || reason.toLowerCase().includes("limit")) {
      reason = "Pinata free plan limit reached. Preview upload skipped — your content will still be registered.";
    } else if (pinataRes.status === 401) {
      reason = "Pinata authentication failed. Check PINATA_JWT in backend .env.";
    }

    return c.json({ error: reason }, 502);
  }

  const data = (await pinataRes.json()) as { IpfsHash: string };
  return c.json({
    cid: data.IpfsHash,
    uri: `ipfs://${data.IpfsHash}`,
    gateway: `${process.env.PINATA_GATEWAY ?? "https://gateway.pinata.cloud"}/ipfs/${data.IpfsHash}`,
  });
});

export { uploadRouter };
