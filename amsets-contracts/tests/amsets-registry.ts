import * as anchor from "@project-serum/anchor";
import { Program, BN } from "@project-serum/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { assert } from "chai";
import { v4 as uuidv4 } from "uuid";
import crypto from "crypto";

// Helper: convert UUID string to 32-byte array
function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32 && i < hex.length / 2; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// Helper: SHA-256 hash as 32-byte array
function sha256Bytes(data: string): Uint8Array {
  return new Uint8Array(
    crypto.createHash("sha256").update(data).digest()
  );
}

describe("amsets-registry", () => {
  // Anchor provider from env (localnet / devnet)
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // @ts-ignore — IDL type will be generated after `anchor build`
  const program = anchor.workspace.AmsetsRegistry as Program<any>;

  let author: Keypair;
  let buyer: Keypair;
  let contentId: Uint8Array;
  let contentMint: Keypair;
  let contentRecordPda: PublicKey;
  let contentRecordBump: number;

  before(async () => {
    // Generate fresh keypairs for each test run
    author = Keypair.generate();
    buyer = Keypair.generate();
    contentMint = Keypair.generate();

    // Airdrop SOL to author and buyer
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(author.publicKey, 5 * LAMPORTS_PER_SOL)
    );
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(buyer.publicKey, 5 * LAMPORTS_PER_SOL)
    );

    // Derive content UUID and PDA
    const uuid = uuidv4();
    contentId = uuidToBytes(uuid);

    [contentRecordPda, contentRecordBump] = await PublicKey.findProgramAddress(
      [Buffer.from("content"), author.publicKey.toBuffer(), contentId],
      program.programId
    );
  });

  it("registers content and mints ownership NFT to author", async () => {
    const contentHash = sha256Bytes("test-file-content-for-hashing");
    const storageUri = "ar://test-arweave-tx-id-12345";
    const previewUri = "ipfs://QmTestPreviewCid12345";
    const basePrice = new BN(0.1 * LAMPORTS_PER_SOL); // 0.1 SOL

    // Derive author's ATA for the access mint
    const authorAta = await getAssociatedTokenAddress(
      contentMint.publicKey,
      author.publicKey
    );

    // Derive fee vault PDA
    const [feeVaultPda] = await PublicKey.findProgramAddress(
      [Buffer.from("fee_vault")],
      program.programId
    );

    await program.methods
      .registerContent(
        Array.from(contentId),
        Array.from(contentHash),
        storageUri,
        previewUri,
        basePrice,
        { sol: {} }, // PaymentToken::Sol
        { personal: {} } // LicenseTerms::Personal
      )
      .accounts({
        author: author.publicKey,
        contentRecord: contentRecordPda,
        accessMint: contentMint.publicKey,
        authorTokenAccount: authorAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([author, contentMint])
      .rpc();

    // Fetch and verify the content record
    const record = await program.account.contentRecord.fetch(contentRecordPda);

    assert.deepEqual(Array.from(record.contentHash), Array.from(contentHash));
    assert.equal(record.storageUri, storageUri);
    assert.equal(record.previewUri, previewUri);
    assert.ok(record.primaryAuthor.equals(author.publicKey));
    assert.ok(record.accessMint.equals(contentMint.publicKey));
    assert.equal(record.basePrice.toNumber(), basePrice.toNumber());
    assert.ok(record.isActive);

    console.log("✅ ContentRecord created:", contentRecordPda.toBase58());
    console.log("✅ Access NFT minted to author:", authorAta.toBase58());
  });

  it("fails to register content with zero price", async () => {
    const newId = uuidToBytes(uuidv4());
    const newMint = Keypair.generate();

    const [newPda] = await PublicKey.findProgramAddress(
      [Buffer.from("content"), author.publicKey.toBuffer(), newId],
      program.programId
    );

    const authorAta = await getAssociatedTokenAddress(
      newMint.publicKey,
      author.publicKey
    );

    try {
      await program.methods
        .registerContent(
          Array.from(newId),
          Array.from(sha256Bytes("file")),
          "ar://some-tx",
          "ipfs://some-cid",
          new BN(0), // Invalid: zero price
          { sol: {} },
          { personal: {} }
        )
        .accounts({
          author: author.publicKey,
          contentRecord: newPda,
          accessMint: newMint.publicKey,
          authorTokenAccount: authorAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([author, newMint])
        .rpc();

      assert.fail("Expected InvalidPrice error");
    } catch (err: any) {
      assert.include(err.toString(), "InvalidPrice");
      console.log("✅ Zero price correctly rejected");
    }
  });

  it("purchases access with SOL and receives access NFT", async () => {
    // Derive fee vault
    const [feeVaultPda] = await PublicKey.findProgramAddress(
      [Buffer.from("fee_vault")],
      program.programId
    );

    const buyerAta = await getAssociatedTokenAddress(
      contentMint.publicKey,
      buyer.publicKey
    );

    const authorBalanceBefore = await provider.connection.getBalance(
      author.publicKey
    );

    await program.methods
      .purchaseAccessSol()
      .accounts({
        buyer: buyer.publicKey,
        contentRecord: contentRecordPda,
        accessMint: contentMint.publicKey,
        buyerTokenAccount: buyerAta,
        author: author.publicKey,
        feeVault: feeVaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([buyer])
      .rpc();

    const authorBalanceAfter = await provider.connection.getBalance(
      author.publicKey
    );

    // Verify author received ~97.5% of 0.1 SOL
    const received = authorBalanceAfter - authorBalanceBefore;
    assert.approximately(
      received,
      0.0975 * LAMPORTS_PER_SOL,
      0.001 * LAMPORTS_PER_SOL,
      "Author should receive 97.5% of sale price"
    );

    // Verify buyer received 1 access NFT
    const buyerTokenBalance = await provider.connection.getTokenAccountBalance(
      buyerAta
    );
    assert.equal(buyerTokenBalance.value.uiAmount, 1);

    console.log("✅ Buyer received access NFT:", buyerAta.toBase58());
    console.log("✅ Author received:", received / LAMPORTS_PER_SOL, "SOL");
  });
});
