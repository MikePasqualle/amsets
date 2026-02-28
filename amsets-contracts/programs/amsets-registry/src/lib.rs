use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};

declare_id!("B2gRbiHAfn7sZo8Kyecoc8xbkMzbgA7f7oJvBVjJxatG");

// ─── Constants ────────────────────────────────────────────────────────────────

/// Protocol fee: 2.5% = 250 / 10_000
const PROTOCOL_FEE_BPS: u64 = 250;
const BPS_DENOMINATOR: u64 = 10_000;

// ─── Enums ────────────────────────────────────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum PaymentToken {
    Sol,
    Usdc,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum LicenseTerms {
    Personal,
    Commercial,
    Derivative,
    Unlimited,
}

// ─── State ────────────────────────────────────────────────────────────────────

/// On-chain record for registered IP content.
/// PDA seeds: [b"content", author.key(), &content_id]
#[account]
pub struct ContentRecord {
    pub content_id:     [u8; 32],
    pub content_hash:   [u8; 32],
    pub storage_uri:    String,   // "ar://{txId}"  — encrypted content on Arweave
    pub preview_uri:    String,   // "ipfs://{cid}" — public preview on IPFS
    pub primary_author: Pubkey,
    /// Optional: pubkey of the SPL mint that gates access. Set after minting.
    pub access_mint:    Pubkey,
    pub base_price:     u64,      // lamports (SOL)
    pub payment_token:  PaymentToken,
    pub license:        LicenseTerms,
    pub is_active:      bool,
    pub bump:           u8,
    // Phase 2: Token system
    pub total_supply:     u32,    // maximum number of access tokens to ever mint
    pub available_supply: u32,    // tokens remaining for sale (decremented on each purchase)
    pub royalty_bps:      u16,    // 0-5000 (50%); author earns this on every token resale
}

impl ContentRecord {
    // discriminator(8) + content_id(32) + content_hash(32)
    // + storage_uri(4+200) + preview_uri(4+200)
    // + primary_author(32) + access_mint(32)
    // + base_price(8) + payment_token(1) + license(1) + is_active(1) + bump(1)
    // + total_supply(4) + available_supply(4) + royalty_bps(2)
    pub const MAX_SIZE: usize = 8 + 32 + 32 + 204 + 204 + 32 + 32 + 8 + 1 + 1 + 1 + 1 + 4 + 4 + 2;
}

/// Per-buyer access receipt. PDA seeds: [b"access", content_record.key(), buyer.key()]
#[account]
pub struct AccessReceipt {
    pub content_record: Pubkey,
    pub buyer:          Pubkey,
    pub amount_paid:    u64,
    pub purchased_at:   i64,
    pub bump:           u8,
}

impl AccessReceipt {
    pub const MAX_SIZE: usize = 8 + 32 + 32 + 8 + 8 + 1;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

#[error_code]
pub enum AmsetsError {
    #[msg("Price must be greater than zero")]
    InvalidPrice,
    #[msg("Content is not active")]
    ContentNotActive,
    #[msg("Insufficient SOL balance")]
    InsufficientPayment,
    #[msg("Only SOL payment supported in this instruction")]
    InvalidPaymentToken,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Content hash cannot be zero bytes")]
    InvalidContentHash,
    #[msg("Storage URI cannot be empty")]
    InvalidStorageUri,
    #[msg("Already purchased")]
    AlreadyPurchased,
    #[msg("All access tokens have been sold out")]
    SoldOut,
    #[msg("Total supply must be greater than zero")]
    InvalidSupply,
}

// ─── Events ───────────────────────────────────────────────────────────────────

#[event]
pub struct ContentRegistered {
    pub content_id:   [u8; 32],
    pub author:       Pubkey,
    pub base_price:   u64,
    pub total_supply: u32,
    pub royalty_bps:  u16,
}

#[event]
pub struct AccessMintSet {
    pub content_id:  [u8; 32],
    pub access_mint: Pubkey,
}

#[event]
pub struct AccessPurchased {
    pub content_id:       [u8; 32],
    pub buyer:            Pubkey,
    pub amount_paid:      u64,
    pub available_supply: u32,
}

#[event]
pub struct AccessTokenMinted {
    pub content_id:  [u8; 32],
    pub buyer:       Pubkey,
    pub access_mint: Pubkey,
}

// ─── Accounts ─────────────────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(content_id: [u8; 32])]
pub struct RegisterContent<'info> {
    #[account(mut)]
    pub author: Signer<'info>,

    /// ContentRecord PDA — unique per (author, content_id)
    #[account(
        init,
        payer = author,
        space = ContentRecord::MAX_SIZE,
        seeds = [b"content", author.key().as_ref(), &content_id],
        bump,
    )]
    pub content_record: Account<'info, ContentRecord>,

    pub system_program: Program<'info, System>,
}

/// Initialises the protocol fee vault PDA so it can receive SOL from purchases.
/// Must be called once by any signer before the first `purchase_access_sol`.
#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: Fee vault PDA — receives 2.5% of every purchase.
    /// Seeds: [b"fee_vault"]. Owned by System Program after init.
    #[account(
        mut,
        seeds = [b"fee_vault"],
        bump,
    )]
    pub fee_vault: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Called by the author after client-side NFT mint creation to link the mint.
#[derive(Accounts)]
pub struct SetAccessMint<'info> {
    #[account(mut)]
    pub author: Signer<'info>,

    #[account(
        mut,
        seeds = [b"content", author.key().as_ref(), &content_record.content_id],
        bump = content_record.bump,
        has_one = primary_author @ AmsetsError::InvalidStorageUri,
    )]
    pub content_record: Account<'info, ContentRecord>,

    /// CHECK: Any pubkey — client provides the SPL mint they created off-chain
    pub access_mint: UncheckedAccount<'info>,

    /// CHECK: satisfies has_one constraint for primary_author
    pub primary_author: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct PurchaseAccessSol<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(
        mut,
        seeds = [
            b"content",
            content_record.primary_author.as_ref(),
            &content_record.content_id,
        ],
        bump = content_record.bump,
        constraint = content_record.is_active @ AmsetsError::ContentNotActive,
        constraint = content_record.payment_token == PaymentToken::Sol
            @ AmsetsError::InvalidPaymentToken,
        constraint = content_record.available_supply > 0 @ AmsetsError::SoldOut,
    )]
    pub content_record: Account<'info, ContentRecord>,

    /// AccessReceipt PDA — one per (content, buyer)
    #[account(
        init,
        payer = buyer,
        space = AccessReceipt::MAX_SIZE,
        seeds = [b"access", content_record.key().as_ref(), buyer.key().as_ref()],
        bump,
    )]
    pub access_receipt: Account<'info, AccessReceipt>,

    /// CHECK: Author wallet — verified via content_record.primary_author
    #[account(mut, address = content_record.primary_author)]
    pub author: UncheckedAccount<'info>,

    /// CHECK: Protocol fee vault PDA
    #[account(mut, seeds = [b"fee_vault"], bump)]
    pub fee_vault: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Verify purchase and emit event for client-side SPL token minting.
///
/// The actual SPL Token-2022 mint is created client-side (avoids crate conflicts).
/// This instruction serves as an on-chain checkpoint: it validates the AccessReceipt
/// PDA exists and emits an AccessTokenMinted event that indexers can track.
#[derive(Accounts)]
pub struct MintAccessToken<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(
        seeds = [
            b"content",
            content_record.primary_author.as_ref(),
            &content_record.content_id,
        ],
        bump = content_record.bump,
    )]
    pub content_record: Account<'info, ContentRecord>,

    /// AccessReceipt PDA — must exist (proves purchase occurred)
    #[account(
        seeds = [b"access", content_record.key().as_ref(), buyer.key().as_ref()],
        bump = access_receipt.bump,
        constraint = access_receipt.buyer == buyer.key(),
        constraint = access_receipt.content_record == content_record.key(),
    )]
    pub access_receipt: Account<'info, AccessReceipt>,
}

// ─── Program ──────────────────────────────────────────────────────────────────

#[program]
pub mod amsets_registry {
    use super::*;

    /// Initialise the fee vault PDA by transferring a minimum rent-exempt amount.
    /// Call this once before the first purchase. Idempotent — safe to call again.
    pub fn initialize_vault(ctx: Context<InitializeVault>, lamports: u64) -> Result<()> {
        let min = Rent::get()?.minimum_balance(0);
        let vault = &ctx.accounts.fee_vault;
        let current = vault.lamports();
        if current < min {
            let to_transfer = (lamports).max(min - current);
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.payer.to_account_info(),
                        to: vault.to_account_info(),
                    },
                ),
                to_transfer,
            )?;
        }
        Ok(())
    }

    /// Register IP content on Solana.
    ///
    /// Creates the ContentRecord PDA with all metadata.
    /// NFT minting is done client-side (TypeScript) after this call returns,
    /// then `set_access_mint` links the mint pubkey back to this record.
    pub fn register_content(
        ctx: Context<RegisterContent>,
        content_id:    [u8; 32],
        content_hash:  [u8; 32],
        storage_uri:   String,
        preview_uri:   String,
        base_price:    u64,
        payment_token: PaymentToken,
        license:       LicenseTerms,
        total_supply:  u32,
        royalty_bps:   u16,
    ) -> Result<()> {
        require!(base_price > 0, AmsetsError::InvalidPrice);
        require!(!storage_uri.is_empty(), AmsetsError::InvalidStorageUri);
        require!(content_hash != [0u8; 32], AmsetsError::InvalidContentHash);
        require!(total_supply > 0, AmsetsError::InvalidSupply);
        require!(royalty_bps <= 5000, AmsetsError::Overflow); // max 50%

        let record = &mut ctx.accounts.content_record;
        record.content_id     = content_id;
        record.content_hash   = content_hash;
        record.storage_uri    = storage_uri;
        record.preview_uri    = preview_uri;
        record.primary_author = ctx.accounts.author.key();
        record.access_mint    = Pubkey::default(); // set later via set_access_mint
        record.base_price     = base_price;
        record.payment_token  = payment_token;
        record.license        = license;
        record.is_active      = true;
        record.bump           = ctx.bumps.content_record;
        record.total_supply     = total_supply;
        record.available_supply = total_supply; // starts equal to total
        record.royalty_bps      = royalty_bps;

        emit!(ContentRegistered {
            content_id,
            author: ctx.accounts.author.key(),
            base_price,
            total_supply,
            royalty_bps,
        });

        Ok(())
    }

    /// Link the SPL mint (created client-side) to an existing ContentRecord.
    pub fn set_access_mint(ctx: Context<SetAccessMint>) -> Result<()> {
        let record = &mut ctx.accounts.content_record;
        let mint_key = ctx.accounts.access_mint.key();
        record.access_mint = mint_key;

        emit!(AccessMintSet {
            content_id: record.content_id,
            access_mint: mint_key,
        });

        Ok(())
    }

    /// Purchase access to registered content by paying SOL.
    ///
    /// Payment split: 97.5% → author, 2.5% → fee vault.
    /// Writes an AccessReceipt PDA — proof of purchase.
    /// Decrements available_supply — reverts if sold out.
    pub fn purchase_access_sol(ctx: Context<PurchaseAccessSol>) -> Result<()> {
        let price = ctx.accounts.content_record.base_price;

        require!(
            ctx.accounts.buyer.lamports() >= price + 5_000_000, // price + ~rent buffer
            AmsetsError::InsufficientPayment
        );

        let fee = price
            .checked_mul(PROTOCOL_FEE_BPS)
            .ok_or(AmsetsError::Overflow)?
            .checked_div(BPS_DENOMINATOR)
            .ok_or(AmsetsError::Overflow)?;
        let author_amount = price.checked_sub(fee).ok_or(AmsetsError::Overflow)?;

        // Transfer 97.5% to author
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.buyer.to_account_info(),
                    to: ctx.accounts.author.to_account_info(),
                },
            ),
            author_amount,
        )?;

        // Transfer 2.5% to protocol fee vault
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.buyer.to_account_info(),
                    to: ctx.accounts.fee_vault.to_account_info(),
                },
            ),
            fee,
        )?;

        // Decrement available supply and capture values before mutable re-borrow
        let content_id_copy;
        let available_after;
        {
            let record = &mut ctx.accounts.content_record;
            record.available_supply = record
                .available_supply
                .checked_sub(1)
                .ok_or(AmsetsError::SoldOut)?;
            content_id_copy = record.content_id;
            available_after = record.available_supply;
        }

        // Write access receipt (immutable borrow of content_record via key())
        let content_record_key = ctx.accounts.content_record.key();
        let receipt = &mut ctx.accounts.access_receipt;
        receipt.content_record = content_record_key;
        receipt.buyer          = ctx.accounts.buyer.key();
        receipt.amount_paid    = price;
        receipt.purchased_at   = Clock::get()?.unix_timestamp;
        receipt.bump           = ctx.bumps.access_receipt;

        emit!(AccessPurchased {
            content_id:       content_id_copy,
            buyer:            ctx.accounts.buyer.key(),
            amount_paid:      price,
            available_supply: available_after,
        });

        Ok(())
    }

    /// Checkpoint: verify a purchase exists and emit AccessTokenMinted event.
    ///
    /// The actual SPL Token-2022 mint happens client-side to avoid crate conflicts.
    /// Indexers (Helius webhooks) pick up the event and update the backend cache.
    pub fn mint_access_token(ctx: Context<MintAccessToken>) -> Result<()> {
        let record = &ctx.accounts.content_record;

        emit!(AccessTokenMinted {
            content_id:  record.content_id,
            buyer:       ctx.accounts.buyer.key(),
            access_mint: record.access_mint,
        });

        Ok(())
    }
}
