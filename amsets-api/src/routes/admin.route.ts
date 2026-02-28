/**
 * Admin routes — protected, not exposed in public API docs.
 *
 * POST /api/v1/admin/deploy      — deploy Solana program via CLI
 * GET  /api/v1/admin/deploy-status — check deployer wallet balance + program status
 */

import { Hono } from "hono";
import { spawn } from "child_process";
import { copyFileSync } from "fs";
import path from "path";
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { verifyWalletSignature } from "../services/solana.service";

const adminRouter = new Hono();

/**
 * Run `solana program deploy` using spawn (not exec).
 *
 * The Solana CLI argument parser breaks on paths with spaces even when the shell
 * properly quotes them. To work around this, we copy both the .so and the
 * program keypair to /tmp (no spaces) before deploying.
 *
 * The program keypair is auto-discovered from the .so file name
 * (amsets_registry.so → amsets_registry-keypair.json in the same dir),
 * so we do NOT pass --program-id explicitly.
 */
function runSolanaDeploy(
  cliKeypair: string,
  soFile: string,
  keypairFile: string
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // Copy files to /tmp to avoid Solana CLI space-in-path bug
    const tmpSo      = "/tmp/amsets_registry.so";
    const tmpKeypair = "/tmp/amsets_registry-keypair.json";
    try {
      copyFileSync(soFile,      tmpSo);
      copyFileSync(keypairFile, tmpKeypair);
    } catch (e: any) {
      return reject(new Error(`Failed to copy deploy files to /tmp: ${e.message}`));
    }

    const args = [
      "program", "deploy",
      "--keypair",  cliKeypair,
      "--url",      "devnet",
      tmpSo,
    ];

    console.log("[admin/deploy] solana", args.join(" "));

    const proc = spawn("solana", args, { stdio: "pipe" });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error("Deploy timed out after 120s"));
    }, 120_000);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr || stdout || `Process exited with code ${code}`));
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

const DEPLOYER_WALLET = "CFLk3NaYLP876Vf8RpNbnymP8igsZJ8YjWd4ac73GQH8";
const PROGRAM_ID      = process.env.PROGRAM_ID ?? "B2gRbiHAfn7sZo8Kyecoc8xbkMzbgA7f7oJvBVjJxatG";
const RPC_URL         = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";

// Path to compiled .so and program keypair (relative to repo root)
const REPO_ROOT   = path.resolve(__dirname, "../../../../");
const SO_FILE     = path.join(REPO_ROOT, "amsets-contracts/target/deploy/amsets_registry.so");
const KEYPAIR_FILE = path.join(REPO_ROOT, "amsets-contracts/target/deploy/amsets_registry-keypair.json");
const CLI_KEYPAIR  = path.join(process.env.HOME ?? "~", ".config/solana/id.json");

// Simple admin auth: check that the request is signed by a known admin wallet.
// For dev/MVP: any wallet that passes signature check can trigger deploy.
// In production, add a whitelist of admin wallet addresses.
function verifyAdminSignature(
  walletAddress: string,
  message: string,
  signature: string,
  timestamp: number
): boolean {
  // Replay protection: reject if older than 5 minutes
  if (Math.abs(Date.now() - timestamp) > 5 * 60 * 1000) return false;
  const expectedMessage = `AMSETS admin: ${walletAddress} at ${timestamp}`;
  if (message !== expectedMessage) return false;
  return verifyWalletSignature(walletAddress, message, signature);
}

// ─── GET /deploy-status ───────────────────────────────────────────────────────

adminRouter.get("/deploy-status", async (c) => {
  const connection = new Connection(RPC_URL, "confirmed");

  // Check deployer wallet balance
  let deployerBalance = 0;
  try {
    deployerBalance = await connection.getBalance(new PublicKey(DEPLOYER_WALLET));
  } catch {}

  // Check if program is already deployed
  let programDeployed = false;
  let programExecutable = false;
  try {
    const info = await connection.getAccountInfo(new PublicKey(PROGRAM_ID));
    programDeployed    = info !== null;
    programExecutable  = info?.executable ?? false;
  } catch {}

  return c.json({
    deployer_wallet:   DEPLOYER_WALLET,
    deployer_balance:  deployerBalance / LAMPORTS_PER_SOL,
    deployer_balance_lamports: deployerBalance,
    program_id:        PROGRAM_ID,
    program_deployed:  programDeployed,
    program_executable: programExecutable,
    rpc_url:           RPC_URL,
    min_sol_needed:    2.5,
    can_deploy:        deployerBalance / LAMPORTS_PER_SOL >= 2.5 && !programExecutable,
  });
});

// ─── POST /deploy ─────────────────────────────────────────────────────────────

adminRouter.post("/deploy", async (c) => {
  const body = await c.req.json().catch(() => ({})) as {
    wallet_address?: string;
    signature?: string;
    timestamp?: number;
  };

  const { wallet_address, signature, timestamp } = body;

  if (!wallet_address || !signature || !timestamp) {
    return c.json({ error: "wallet_address, signature and timestamp are required" }, 400);
  }

  const message = `AMSETS admin: ${wallet_address} at ${timestamp}`;
  if (!verifyAdminSignature(wallet_address, message, signature, timestamp)) {
    return c.json({ error: "Invalid or expired admin signature" }, 401);
  }

  // Check deployer balance
  const connection = new Connection(RPC_URL, "confirmed");
  const deployerBalance = await connection.getBalance(new PublicKey(DEPLOYER_WALLET));
  const deployerSOL = deployerBalance / LAMPORTS_PER_SOL;

  if (deployerSOL < 2.5) {
    return c.json({
      error: `Deployer wallet needs at least 2.5 SOL (has ${deployerSOL.toFixed(4)} SOL). Send SOL to: ${DEPLOYER_WALLET}`,
      deployer_wallet: DEPLOYER_WALLET,
      current_balance: deployerSOL,
    }, 402);
  }

  // Check if already deployed
  const existing = await connection.getAccountInfo(new PublicKey(PROGRAM_ID));
  if (existing?.executable) {
    return c.json({
      success: true,
      message: "Program already deployed and executable.",
      program_id: PROGRAM_ID,
    });
  }

  // Run solana program deploy (using spawn + /tmp copy to avoid space-in-path bug)
  try {
    const { stdout, stderr } = await runSolanaDeploy(CLI_KEYPAIR, SO_FILE, KEYPAIR_FILE);
    const output = stdout + (stderr ? `\nSTDERR: ${stderr}` : "");
    console.log("[admin/deploy] Output:", output);

    return c.json({
      success: true,
      program_id: PROGRAM_ID,
      output: output.trim(),
    });
  } catch (err: any) {
    console.error("[admin/deploy] Failed:", err);
    return c.json({
      success: false,
      error: err?.message ?? "Deploy failed",
    }, 500);
  }
});

export { adminRouter };
