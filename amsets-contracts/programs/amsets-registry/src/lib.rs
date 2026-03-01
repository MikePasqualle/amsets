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
    pub storage_uri:    String,   // "livepeer://{playbackId}" or "ar://{txId}"
    pub preview_uri:    String,   // "ipfs://{cid}" — public preview on IPFS
    pub primary_author: Pubkey,
    /// Pubkey of the SPL access-token mint that gates content viewing.
    pub access_mint:    Pubkey,
    /// Pubkey of the 1-of-1 Author NFT mint (royalty rights).
    /// Whoever holds this token receives royalties on all sales.
    pub author_nft_mint: Pubkey,
    pub base_price:     u64,      // lamports (SOL)
    pub payment_token:  PaymentToken,
    pub license:        LicenseTerms,
    pub is_active:      bool,
    pub bump:           u8,
    // Token supply management
    pub total_supply:     u32,    // maximum access tokens to ever mint
    pub available_supply: u32,    // tokens remaining (decremented on each primary purchase)
    pub royalty_bps:      u16,    // 0-5000 (50%); NFT holder earns this on every secondary sale
}

impl ContentRecord {
    // discriminator(8) + content_id(32) + content_hash(32)
    // + storage_uri(4+200) + preview_uri(4+200)
    // + primary_author(32) + access_mint(32) + author_nft_mint(32)
    // + base_price(8) + payment_token(1) + license(1) + is_active(1) + bump(1)
    // + total_supply(4) + available_supply(4) + royalty_bps(2)
    pub const MAX_SIZE: usize = 8 + 32 + 32 + 204 + 204 + 32 + 32 + 32 + 8 + 1 + 1 + 1 + 1 + 4 + 4 + 2;
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

/// On-chain listing record for secondary market.
/// PDA seeds: [b"listing", &listing_id]
/// Created when a token holder lists their access token for sale.
/// Token is held in a backend-controlled escrow ATA (via PermanentDelegate).
#[account]
pub struct ListingRecord {
    pub listing_id:     [u8; 32],   // UUID as 32 bytes — used as PDA seed
    pub content_id:     [u8; 32],
    pub seller:         Pubkey,
    pub price_lamports: u64,
    pub token_mint:     Pubkey,     // access_mint address
    pub status:         u8,         // 0=active, 1=sold, 2=cancelled
    pub created_at:     i64,
    pub bump:           u8,
}

impl ListingRecord {
    // discriminator(8) + listing_id(32) + content_id(32) + seller(32)
    // + price_lamports(8) + token_mint(32) + status(1) + created_at(8) + bump(1)
    pub const MAX_SIZE: usize = 8 + 32 + 32 + 32 + 8 + 32 + 1 + 8 + 1;
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
    #[msg("Listing is not active")]
    ListingNotActive,
    #[msg("Cannot buy your own listing")]
    CannotBuyOwnListing,
    #[msg("Only the listing seller can cancel")]
    InvalidListingSeller,
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
pub struct AuthorNftMintSet {
    pub content_id:      [u8; 32],
    pub author_nft_mint: Pubkey,
}

#[event]
pub struct AccessPurchased {
    pub content_id:       [u8; 32],
    pub buyer:            Pubkey,
    pub amount_paid:      u64,
    pub royalty_recipient: Pubkey,
    pub available_supply: u32,
}

#[event]
pub struct AccessTokenMinted {
    pub content_id:  [u8; 32],
    pub buyer:       Pubkey,
    pub access_mint: Pubkey,
}

#[event]
pub struct ListingCreated {
    pub listing_id:     [u8; 32],
    pub content_id:     [u8; 32],
    pub seller:         Pubkey,
    pub price_lamports: u64,
}

#[event]
pub struct ListingCancelled {
    pub listing_id: [u8; 32],
    pub seller:     Pubkey,
}

#[event]
pub struct SaleExecuted {
    pub listing_id:        [u8; 32],
    pub buyer:             Pubkey,
    pub seller:            Pubkey,
    pub price_lamports:    u64,
    pub royalty_recipient: Pubkey,
}

// ─── Account Contexts ─────────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(content_id: [u8; 32])]
pub struct RegisterContent<'info> {
    #[account(mut)]
    pub author: Signer<'info>,

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

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: Fee vault PDA — receives 2.5% of every purchase.
    #[account(mut, seeds = [b"fee_vault"], bump)]
    pub fee_vault: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Link the access-token SPL mint to a ContentRecord.
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

    /// CHECK: SPL mint created off-chain
    pub access_mint: UncheckedAccount<'info>,

    /// CHECK: satisfies has_one constraint
    pub primary_author: UncheckedAccount<'info>,
}

/// Link the 1-of-1 Author NFT mint to a ContentRecord.
#[derive(Accounts)]
pub struct SetAuthorNftMint<'info> {
    #[account(mut)]
    pub author: Signer<'info>,

    #[account(
        mut,
        seeds = [b"content", author.key().as_ref(), &content_record.content_id],
        bump = content_record.bump,
        has_one = primary_author @ AmsetsError::InvalidStorageUri,
    )]
    pub content_record: Account<'info, ContentRecord>,

    /// CHECK: 1-of-1 Author NFT SPL mint created off-chain
    pub author_nft_mint: UncheckedAccount<'info>,

    /// CHECK: satisfies has_one constraint
    pub primary_author: UncheckedAccount<'info>,
}

/// PRIMARY PURCHASE: buyer pays SOL, supply decremented, AccessReceipt created.
/// Payment split: 2.5% → fee_vault, remainder → royalty_recipient (current Author NFT holder).
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

    /// CHECK: Current holder of the Author NFT — receives all revenue minus fee.
    /// Resolved off-chain via Helius DAS and passed at call time.
    #[account(mut)]
    pub royalty_recipient: UncheckedAccount<'info>,

    /// CHECK: Protocol fee vault PDA
    #[account(mut, seeds = [b"fee_vault"], bump)]
    pub fee_vault: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Checkpoint: verify purchase and emit event for indexers.
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

    #[account(
        seeds = [b"access", content_record.key().as_ref(), buyer.key().as_ref()],
        bump = access_receipt.bump,
        constraint = access_receipt.buyer == buyer.key(),
        constraint = access_receipt.content_record == content_record.key(),
    )]
    pub access_receipt: Account<'info, AccessReceipt>,
}

/// Create a secondary market listing for an access token.
/// Seller signs to create the ListingRecord PDA.
/// Backend (PermanentDelegate) moves the token to escrow ATA after this tx.
#[derive(Accounts)]
#[instruction(listing_id: [u8; 32])]
pub struct CreateListing<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,

    #[account(
        init,
        payer = seller,
        space = ListingRecord::MAX_SIZE,
        seeds = [b"listing", listing_id.as_ref()],
        bump,
    )]
    pub listing_record: Account<'info, ListingRecord>,

    pub system_program: Program<'info, System>,
}

/// Cancel a listing — only the original seller can cancel.
/// Backend returns the escrowed token to seller after this tx.
#[derive(Accounts)]
pub struct CancelListing<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,

    #[account(
        mut,
        seeds = [b"listing", listing_record.listing_id.as_ref()],
        bump = listing_record.bump,
        constraint = listing_record.seller == seller.key() @ AmsetsError::InvalidListingSeller,
        constraint = listing_record.status == 0 @ AmsetsError::ListingNotActive,
    )]
    pub listing_record: Account<'info, ListingRecord>,
}

/// Execute a secondary market sale.
/// Buyer pays SOL; distribution: 2.5% → fee_vault, royalty_bps → royalty_recipient, rest → seller.
/// Backend moves the escrowed access token to buyer after this tx.
#[derive(Accounts)]
pub struct ExecuteSale<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"listing", listing_record.listing_id.as_ref()],
        bump = listing_record.bump,
        constraint = listing_record.status == 0 @ AmsetsError::ListingNotActive,
        constraint = listing_record.seller != buyer.key() @ AmsetsError::CannotBuyOwnListing,
    )]
    pub listing_record: Account<'info, ListingRecord>,

    /// Content record — read-only, used to get royalty_bps.
    #[account(
        seeds = [
            b"content",
            content_record.primary_author.as_ref(),
            &content_record.content_id,
        ],
        bump = content_record.bump,
    )]
    pub content_record: Account<'info, ContentRecord>,

    /// CHECK: Protocol fee vault
    #[account(mut, seeds = [b"fee_vault"], bump)]
    pub fee_vault: UncheckedAccount<'info>,

    /// CHECK: Current Author NFT holder — receives royalty in SOL.
    #[account(mut)]
    pub royalty_recipient: UncheckedAccount<'info>,

    /// CHECK: Listing seller — receives sale proceeds minus fee and royalty.
    #[account(mut, address = listing_record.seller)]
    pub seller: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

// ─── Program ──────────────────────────────────────────────────────────────────

#[program]
pub mod amsets_registry {
    use super::*;

    /// Initialise the fee vault PDA. Idempotent — safe to call multiple times.
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

    /// Register IP content on-chain. Creates the ContentRecord PDA.
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
        require!(royalty_bps <= 5000, AmsetsError::Overflow);

        let record = &mut ctx.accounts.content_record;
        record.content_id       = content_id;
        record.content_hash     = content_hash;
        record.storage_uri      = storage_uri;
        record.preview_uri      = preview_uri;
        record.primary_author   = ctx.accounts.author.key();
        record.access_mint      = Pubkey::default();
        record.author_nft_mint  = Pubkey::default();
        record.base_price       = base_price;
        record.payment_token    = payment_token;
        record.license          = license;
        record.is_active        = true;
        record.bump             = ctx.bumps.content_record;
        record.total_supply     = total_supply;
        record.available_supply = total_supply;
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

    /// Link the access-token SPL mint to an existing ContentRecord.
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

    /// Link the 1-of-1 Author NFT mint to an existing ContentRecord.
    /// Whoever holds this token is the royalty recipient for all sales.
    pub fn set_author_nft_mint(ctx: Context<SetAuthorNftMint>) -> Result<()> {
        let record = &mut ctx.accounts.content_record;
        let nft_mint_key = ctx.accounts.author_nft_mint.key();
        record.author_nft_mint = nft_mint_key;

        emit!(AuthorNftMintSet {
            content_id: record.content_id,
            author_nft_mint: nft_mint_key,
        });

        Ok(())
    }

    /// PRIMARY PURCHASE: buyer pays SOL for content access.
    ///
    /// Payment split:
    ///   2.5% → fee_vault (protocol)
    ///   97.5% → royalty_recipient (current Author NFT holder)
    ///
    /// royalty_recipient is the current holder of the Author NFT, resolved
    /// off-chain via Helius DAS and passed as an account at call time.
    /// If the author has not transferred the NFT, they receive the full 97.5%.
    pub fn purchase_access_sol(ctx: Context<PurchaseAccessSol>) -> Result<()> {
        let price = ctx.accounts.content_record.base_price;

        require!(
            ctx.accounts.buyer.lamports() >= price + 5_000_000,
            AmsetsError::InsufficientPayment
        );

        let fee = price
            .checked_mul(PROTOCOL_FEE_BPS)
            .ok_or(AmsetsError::Overflow)?
            .checked_div(BPS_DENOMINATOR)
            .ok_or(AmsetsError::Overflow)?;

        let royalty_amount = price.checked_sub(fee).ok_or(AmsetsError::Overflow)?;

        // Transfer fee to protocol vault
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

        // Transfer remainder to current Author NFT holder
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.buyer.to_account_info(),
                    to: ctx.accounts.royalty_recipient.to_account_info(),
                },
            ),
            royalty_amount,
        )?;

        // Decrement available supply
        let content_id_copy;
        let available_after;
        let royalty_recipient_key = ctx.accounts.royalty_recipient.key();
        {
            let record = &mut ctx.accounts.content_record;
            record.available_supply = record
                .available_supply
                .checked_sub(1)
                .ok_or(AmsetsError::SoldOut)?;
            content_id_copy = record.content_id;
            available_after = record.available_supply;
        }

        // Write access receipt
        let content_record_key = ctx.accounts.content_record.key();
        let receipt = &mut ctx.accounts.access_receipt;
        receipt.content_record = content_record_key;
        receipt.buyer          = ctx.accounts.buyer.key();
        receipt.amount_paid    = price;
        receipt.purchased_at   = Clock::get()?.unix_timestamp;
        receipt.bump           = ctx.bumps.access_receipt;

        emit!(AccessPurchased {
            content_id:        content_id_copy,
            buyer:             ctx.accounts.buyer.key(),
            amount_paid:       price,
            royalty_recipient: royalty_recipient_key,
            available_supply:  available_after,
        });

        Ok(())
    }

    /// Checkpoint: verify purchase exists and emit event for indexers.
    pub fn mint_access_token(ctx: Context<MintAccessToken>) -> Result<()> {
        let record = &ctx.accounts.content_record;

        emit!(AccessTokenMinted {
            content_id:  record.content_id,
            buyer:       ctx.accounts.buyer.key(),
            access_mint: record.access_mint,
        });

        Ok(())
    }

    /// Create a secondary market listing. Seller signs to create the ListingRecord PDA.
    /// After this tx, backend (PermanentDelegate) moves seller's token to escrow ATA.
    pub fn create_listing(
        ctx: Context<CreateListing>,
        listing_id:     [u8; 32],
        content_id:     [u8; 32],
        price_lamports: u64,
        token_mint:     Pubkey,
    ) -> Result<()> {
        require!(price_lamports > 0, AmsetsError::InvalidPrice);

        let listing = &mut ctx.accounts.listing_record;
        listing.listing_id     = listing_id;
        listing.content_id     = content_id;
        listing.seller         = ctx.accounts.seller.key();
        listing.price_lamports = price_lamports;
        listing.token_mint     = token_mint;
        listing.status         = 0; // active
        listing.created_at     = Clock::get()?.unix_timestamp;
        listing.bump           = ctx.bumps.listing_record;

        emit!(ListingCreated {
            listing_id,
            content_id,
            seller: ctx.accounts.seller.key(),
            price_lamports,
        });

        Ok(())
    }

    /// Cancel a secondary market listing. Only the seller can cancel.
    /// After this tx, backend returns the escrowed token to the seller.
    pub fn cancel_listing(ctx: Context<CancelListing>) -> Result<()> {
        let listing = &mut ctx.accounts.listing_record;
        listing.status = 2; // cancelled

        emit!(ListingCancelled {
            listing_id: listing.listing_id,
            seller:     ctx.accounts.seller.key(),
        });

        Ok(())
    }

    /// Execute a secondary market sale.
    ///
    /// SOL distribution (on-chain):
    ///   2.5% → fee_vault
    ///   royalty_bps / 10_000 × price → royalty_recipient (current Author NFT holder)
    ///   remainder → seller
    ///
    /// After this tx, backend (PermanentDelegate) delivers access token
    /// from escrow ATA to buyer.
    pub fn execute_sale(ctx: Context<ExecuteSale>) -> Result<()> {
        let price      = ctx.accounts.listing_record.price_lamports;
        let royalty_bps = ctx.accounts.content_record.royalty_bps as u64;

        require!(
            ctx.accounts.buyer.lamports() >= price + 5_000_000,
            AmsetsError::InsufficientPayment
        );

        // Compute splits
        let platform_fee = price
            .checked_mul(PROTOCOL_FEE_BPS)
            .ok_or(AmsetsError::Overflow)?
            .checked_div(BPS_DENOMINATOR)
            .ok_or(AmsetsError::Overflow)?;

        let royalty = price
            .checked_mul(royalty_bps)
            .ok_or(AmsetsError::Overflow)?
            .checked_div(BPS_DENOMINATOR)
            .ok_or(AmsetsError::Overflow)?;

        let seller_amount = price
            .checked_sub(platform_fee)
            .ok_or(AmsetsError::Overflow)?
            .checked_sub(royalty)
            .ok_or(AmsetsError::Overflow)?;

        // Transfer platform fee
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.buyer.to_account_info(),
                    to:   ctx.accounts.fee_vault.to_account_info(),
                },
            ),
            platform_fee,
        )?;

        // Transfer royalty to current Author NFT holder
        if royalty > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.buyer.to_account_info(),
                        to:   ctx.accounts.royalty_recipient.to_account_info(),
                    },
                ),
                royalty,
            )?;
        }

        // Transfer remainder to seller
        if seller_amount > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.buyer.to_account_info(),
                        to:   ctx.accounts.seller.to_account_info(),
                    },
                ),
                seller_amount,
            )?;
        }

        // Capture values before mutable borrow
        let listing_id_copy   = ctx.accounts.listing_record.listing_id;
        let buyer_key         = ctx.accounts.buyer.key();
        let seller_key        = ctx.accounts.seller.key();
        let royalty_recip_key = ctx.accounts.royalty_recipient.key();

        // Mark listing as sold
        ctx.accounts.listing_record.status = 1;

        emit!(SaleExecuted {
            listing_id:        listing_id_copy,
            buyer:             buyer_key,
            seller:            seller_key,
            price_lamports:    price,
            royalty_recipient: royalty_recip_key,
        });

        Ok(())
    }
}
