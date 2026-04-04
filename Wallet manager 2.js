// walletManager.js
import { Keypair, LAMPORTS_PER_SOL, Connection } from "@solana/web3.js";
import bs58 from "bs58";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WALLETS_FILE = path.join(__dirname, "wallets.json");
const WALLETS_BACKUP = path.join(__dirname, "wallets.backup.json");

/**
 * WalletPool — Manages 10,000+ persistent Solana wallets.
 * 
 * Wallets are stored as JSON on disk and loaded into memory on boot.
 * All batch operations (fund, drain, balance scan) use configurable
 * concurrency to avoid RPC rate limits.
 * 
 * Features:
 * - Atomic file writes for crash safety
 * - Rate-limit aware batch execution with retry
 * - Per-wallet rate limiting to avoid RPC spam
 * - Progress callbacks for UI updates
 * - Cancellation support via checkRunning callback
 * - Memory-efficient random subset selection
 */
export class WalletPool {
    constructor() {
        /** @type {Keypair[]} */
        this.wallets = [];
        /** @type {Map<string, Keypair>} */
        this.publicKeyMap = new Map();
        this._load();
    }

    // ─── Persistence ───────────────────────────────

    /**
     * Load wallets from disk with error recovery
     */
    _load() {
        try {
            if (fs.existsSync(WALLETS_FILE)) {
                const raw = JSON.parse(fs.readFileSync(WALLETS_FILE, "utf-8"));
                this.wallets = raw.map(w => {
                    const kp = Keypair.fromSecretKey(bs58.decode(w.secretKey));
                    this.publicKeyMap.set(kp.publicKey.toBase58(), kp);
                    return kp;
                });
                console.log(`✅ [WalletPool] Loaded ${this.wallets.length} wallets from disk.`);
            } else {
                console.log(`ℹ️ [WalletPool] No wallets.json found. Starting with empty pool.`);
            }
        } catch (e) {
            console.error(`⚠️ [WalletPool] Failed to load wallets.json: ${e.message}`);
            // Try backup file
            try {
                if (fs.existsSync(WALLETS_BACKUP)) {
                    const raw = JSON.parse(fs.readFileSync(WALLETS_BACKUP, "utf-8"));
                    this.wallets = raw.map(w => {
                        const kp = Keypair.fromSecretKey(bs58.decode(w.secretKey));
                        this.publicKeyMap.set(kp.publicKey.toBase58(), kp);
                        return kp;
                    });
                    console.log(`✅ [WalletPool] Recovered ${this.wallets.length} wallets from backup.`);
                }
            } catch (backupErr) {
                console.error(`❌ [WalletPool] Backup recovery failed: ${backupErr.message}`);
            }
            this.wallets = [];
            this.publicKeyMap.clear();
        }
    }

    /**
     * Save wallets to disk with atomic write (temp file + rename)
     */
    _save() {
        try {
            const data = this.wallets.map(kp => ({
                publicKey: kp.publicKey.toBase58(),
                secretKey: bs58.encode(kp.secretKey)
            }));
            
            // Atomic write: write to temp file first, then rename
            const tempFile = WALLETS_FILE + '.tmp';
            fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), "utf-8");
            
            // Create backup of existing file before overwriting
            if (fs.existsSync(WALLETS_FILE)) {
                fs.copyFileSync(WALLETS_FILE, WALLETS_BACKUP);
            }
            
            // Atomic rename
            fs.renameSync(tempFile, WALLETS_FILE);
            
            // Update in-memory index
            this.publicKeyMap.clear();
            for (const wallet of this.wallets) {
                this.publicKeyMap.set(wallet.publicKey.toBase58(), wallet);
            }
            
            console.debug(`💾 [WalletPool] Saved ${this.wallets.length} wallets to disk.`);
        } catch (e) {
            console.error(`❌ [WalletPool] Failed to save wallets.json: ${e.message}`);
            // Clean up temp file if it exists
            try {
                const tempFile = WALLETS_FILE + '.tmp';
                if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
            } catch {}
        }
    }

    // ─── Generation ────────────────────────────────

    /**
     * Generate `count` new wallets and append to the pool.
     * Generates in chunks to avoid blocking the event loop.
     * 
     * @param {number} count - Number of wallets to generate
     * @param {Function} progressCb - Optional callback: ({generated, total}) => void
     * @returns {Promise<number>} Number of wallets actually generated
     */
    async generateWallets(count, progressCb = null) {
        if (!count || count <= 0) return 0;
        
        const CHUNK = 500;
        let generated = 0;
        const startTime = Date.now();

        while (generated < count) {
            const batchSize = Math.min(CHUNK, count - generated);
            
            for (let i = 0; i < batchSize; i++) {
                const kp = Keypair.generate();
                this.wallets.push(kp);
                this.publicKeyMap.set(kp.publicKey.toBase58(), kp);
            }
            
            generated += batchSize;

            if (progressCb) {
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                const rate = (generated / (Date.now() - startTime) * 1000).toFixed(0);
                progressCb({ 
                    generated, 
                    total: count,
                    elapsed: `${elapsed}s`,
                    rate: `${rate}/s`
                });
            }

            // Yield to event loop every chunk to prevent blocking
            await new Promise(r => setImmediate(r));
        }

        // Persist to disk
        this._save();
        
        const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`✅ [WalletPool] Generated ${generated} wallets in ${totalTime}s`);
        return generated;
    }

    // ─── Batch Operations ──────────────────────────

    /**
     * Concurrency-limited async executor with retry and rate limiting.
     * Runs `fn(item, index)` for each item with at most `concurrency` in flight.
     * 
     * @param {Array} items - Items to process
     * @param {Function} fn - Async function: (item, index) => Promise
     * @param {number} concurrency - Max parallel operations
     * @param {Function} progressCb - Optional: ({completed, total, successes, failures}) => void
     * @param {Function} checkRunning - Optional: () => boolean to check if should continue
     * @param {number} maxRetries - Max retry attempts for transient errors
     * @returns {Promise<{completed, successes, failures}>}
     */
    async _batchExecute(items, fn, concurrency, progressCb = null, checkRunning = null, maxRetries = 2) {
        if (!items?.length) return { completed: 0, successes: 0, failures: 0 };
        
        let completed = 0;
        let successes = 0;
        let failures = 0;
        const total = items.length;
        let index = 0;
        const startTime = Date.now();

        // Per-wallet rate limiting to avoid RPC spam
        const lastCallTime = new Map();
        const MIN_INTERVAL_MS = 100; // Minimum ms between calls per wallet

        const worker = async () => {
            while (index < total) {
                // Check cancellation signal
                if (checkRunning && !checkRunning()) {
                    console.log(`[WalletPool] Worker stopped: checkRunning returned false`);
                    break;
                }
                
                const currentIndex = index++;
                const item = items[currentIndex];
                const itemKey = item?.publicKey?.toBase58?.() || `item_${currentIndex}`;
                let lastError;

                // Retry loop for transient errors
                for (let attempt = 0; attempt <= maxRetries; attempt++) {
                    try {
                        // Per-item rate limiting
                        const lastTime = lastCallTime.get(itemKey) || 0;
                        const now = Date.now();
                        const elapsed = now - lastTime;
                        
                        if (elapsed < MIN_INTERVAL_MS) {
                            await new Promise(r => setTimeout(r, MIN_INTERVAL_MS - elapsed));
                        }
                        lastCallTime.set(itemKey, Date.now());

                        // Execute the operation
                        await fn(item, currentIndex);
                        successes++;
                        lastError = null;
                        break; // Success - exit retry loop
                        
                    } catch (err) {
                        lastError = err;
                        
                        // Determine if error is retryable
                        const isRetryable = 
                            err.message?.includes('timeout') ||
                            err.message?.includes('429') ||
                            err.message?.includes('rate limit') ||
                            err.message?.includes('blockhash') ||
                            err.message?.includes('Transaction was not confirmed') ||
                            err.message?.includes('failed to get') ||
                            err.code === 'TIMEOUT' ||
                            err.code === 'ETIMEDOUT';
                        
                        if (isRetryable && attempt < maxRetries) {
                            // Exponential backoff with jitter
                            const baseDelay = 500 * Math.pow(2, attempt);
                            const jitter = baseDelay * 0.1 * Math.random();
                            const delay = Math.min(baseDelay + jitter, 3000);
                            console.debug(`[WalletPool] Item ${currentIndex} retry ${attempt+1}/${maxRetries} in ${Math.round(delay)}ms: ${err.message}`);
                            await new Promise(r => setTimeout(r, delay));
                            continue;
                        }
                        
                        // Non-retryable error or max retries exceeded
                        break;
                    }
                }

                if (lastError) {
                    failures++;
                    console.error(`[WalletPool] Item ${currentIndex} (${itemKey.slice(0,8)}...) failed: ${lastError.message}`);
                }

                completed++;

                // Progress callback throttled to ~5% intervals to avoid spam
                if (progressCb && (completed % Math.max(1, Math.floor(total / 20)) === 0 || completed === total)) {
                    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                    const rate = (completed / (Date.now() - startTime) * 1000).toFixed(1);
                    const eta = total > completed ? Math.round((total - completed) / (completed / (Date.now() - startTime))) : 0;
                    
                    progressCb({ 
                        completed, 
                        total, 
                        successes, 
                        failures,
                        percent: Math.round((completed / total) * 100),
                        elapsed: `${elapsed}s`,
                        rate: `${rate}/s`,
                        eta: eta > 0 ? `${Math.round(eta/1000)}s` : 'done'
                    });
                }
            }
        };

        // Spawn worker promises up to concurrency limit
        const workerCount = Math.min(concurrency, total);
        const workers = Array.from({ length: workerCount }, () => worker());
        
        await Promise.all(workers);
        
        const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[WalletPool] Batch complete: ${successes}/${total} succeeded, ${failures} failed in ${totalTime}s`);
        
        return { completed, successes, failures };
    }

    /**
     * Fund all wallets from a master keypair.
     * Skips wallets that already have >= amountSOL balance (with 10% tolerance).
     * 
     * @param {Connection} connection - Solana connection
     * @param {Keypair} masterKeypair - Master wallet to fund from
     * @param {Function} sendSOLFn - Async function: (conn, from, toPubkey, amountSOL) => Promise<txid>
     * @param {number} amountSOL - Amount of SOL to send per wallet
     * @param {number} concurrency - Max parallel funding operations
     * @param {Function} progressCb - Optional progress callback
     * @param {Function} checkRunning - Optional cancellation check
     * @returns {Promise<{completed, successes, failures, skipped}>}
     */
    async fundAll(connection, masterKeypair, sendSOLFn, amountSOL, concurrency = 10, progressCb = null, checkRunning = null) {
        if (!this.wallets.length) {
            console.warn('[WalletPool] fundAll called with empty pool');
            return { completed: 0, successes: 0, failures: 0, skipped: 0 };
        }

        console.log(`[WalletPool] Scanning ${this.wallets.length} wallets for funding needs...`);
        
        // First, scan which wallets need funding (batched for efficiency)
        const walletsToFund = [];
        const scanResults = await this.scanBalances(connection, Math.min(concurrency * 2, 30));

        for (let i = 0; i < this.wallets.length; i++) {
            const bal = scanResults.balances[i] || 0;
            const threshold = amountSOL * LAMPORTS_PER_SOL * 0.9; // 10% tolerance
            if (bal < threshold) {
                walletsToFund.push(this.wallets[i]);
            }
        }

        const skipped = this.wallets.length - walletsToFund.length;
        console.log(`[WalletPool] Funding ${walletsToFund.length} wallets, skipping ${skipped} already funded`);

        if (walletsToFund.length === 0) {
            if (progressCb) progressCb({ completed: 0, total: 0, successes: 0, failures: 0, skipped });
            return { completed: 0, successes: 0, failures: 0, skipped };
        }

        if (progressCb) {
            progressCb({ 
                completed: 0, 
                total: walletsToFund.length, 
                successes: 0, 
                failures: 0, 
                skipped,
                phase: 'funding'
            });
        }

        const result = await this._batchExecute(
            walletsToFund,
            async (wallet) => {
                await sendSOLFn(connection, masterKeypair, wallet.publicKey, amountSOL);
            },
            concurrency,
            progressCb,
            checkRunning
        );

        return { ...result, skipped };
    }

    /**
     * Drain all wallets back to the master wallet.
     * Leaves MIN_RENT lamports for rent-exemption.
     * 
     * @param {Connection} connection - Solana connection
     * @param {Keypair} masterKeypair - Destination wallet
     * @param {Function} sendSOLFn - Async function: (conn, from, toPubkey, amountSOL) => Promise<txid>
     * @param {number} concurrency - Max parallel drain operations
     * @param {Function} progressCb - Optional progress callback
     * @param {Function} checkRunning - Optional cancellation check
     * @returns {Promise<{completed, successes, failures}>}
     */
    async drainAll(connection, masterKeypair, sendSOLFn, concurrency = 10, progressCb = null, checkRunning = null) {
        if (!this.wallets.length) {
            console.warn('[WalletPool] drainAll called with empty pool');
            return { completed: 0, successes: 0, failures: 0 };
        }

        const MIN_RENT = 5000; // Lamports to leave for rent exemption
        const MIN_DRAIN = 10000; // Minimum balance to trigger drain

        console.log(`[WalletPool] Draining ${this.wallets.length} wallets to ${masterKeypair.publicKey.toBase58().slice(0,8)}...`);

        return await this._batchExecute(
            this.wallets,
            async (wallet) => {
                try {
                    const bal = await connection.getBalance(wallet.publicKey, 'confirmed');
                    if (bal > MIN_RENT + MIN_DRAIN) {
                        const drainAmount = (bal - MIN_RENT) / LAMPORTS_PER_SOL;
                        await sendSOLFn(connection, wallet, masterKeypair.publicKey, drainAmount);
                    }
                } catch (err) {
                    // Re-throw to be handled by retry logic
                    throw err;
                }
            },
            concurrency,
            progressCb,
            checkRunning
        );
    }

    /**
     * Scan balances of all wallets.
     * Returns aggregated stats and individual balances array.
     * 
     * @param {Connection} connection - Solana connection
     * @param {number} concurrency - Max parallel balance queries
     * @returns {Promise<{totalSOL, funded, empty, balances: number[]}>}
     */
    async scanBalances(connection, concurrency = 20) {
        if (!this.wallets.length) {
            return { totalSOL: 0, funded: 0, empty: 0, balances: [] };
        }

        const balances = new Array(this.wallets.length).fill(0);
        let totalLamports = 0;
        let funded = 0;
        let empty = 0;
        const startTime = Date.now();

        await this._batchExecute(
            this.wallets,
            async (wallet, i) => {
                try {
                    const bal = await connection.getBalance(wallet.publicKey, 'confirmed');
                    balances[i] = bal;
                    totalLamports += bal;
                    if (bal > 10000) funded++;
                    else empty++;
                } catch {
                    empty++;
                    balances[i] = 0;
                }
            },
            concurrency,
            null, // No progress callback for internal scan
            null  // No cancellation check for internal scan
        );

        const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
        const totalSOL = totalLamports / LAMPORTS_PER_SOL;
        
        console.log(`[WalletPool] Balance scan complete: ${totalSOL.toFixed(4)} SOL total, ${funded} funded, ${empty} empty in ${totalTime}s`);
        
        return { 
            totalSOL, 
            totalLamports,
            funded, 
            empty, 
            balances,
            scanned: this.wallets.length,
            duration: totalTime
        };
    }

    // ─── Selection ─────────────────────────────────

    /**
     * Get a random subset of `count` wallets from the pool.
     * Uses Fisher-Yates partial shuffle for O(count) performance.
     * Does not modify the original pool.
     * 
     * @param {number} count - Number of wallets to select
     * @returns {Keypair[]} Array of selected Keypairs
     */
    getRandomSubset(count) {
        const n = Math.min(count, this.wallets.length);
        if (n <= 0) return [];
        if (n === this.wallets.length) return [...this.wallets];
        
        // Create a shallow copy for shuffling
        const pool = [...this.wallets];
        
        // Fisher-Yates partial shuffle: only shuffle the last n elements
        for (let i = pool.length - 1; i > pool.length - 1 - n && i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [pool[i], pool[j]] = [pool[j], pool[i]];
        }
        
        return pool.slice(pool.length - n);
    }

    /**
     * Get wallet by public key string (base58)
     * 
     * @param {string} pubkeyBase58 - Public key in base58 format
     * @returns {Keypair|undefined} The wallet if found, undefined otherwise
     */
    getByPublicKey(pubkeyBase58) {
        return this.publicKeyMap.get(pubkeyBase58);
    }

    /**
     * Check if a public key exists in the pool
     * 
     * @param {string} pubkeyBase58 - Public key in base58 format
     * @returns {boolean} True if wallet exists in pool
     */
    hasWallet(pubkeyBase58) {
        return this.publicKeyMap.has(pubkeyBase58);
    }

    // ─── Management ────────────────────────────────

    /**
     * Clear all wallets from pool and delete the file.
     * Creates a backup before deletion.
     */
    clearAll() {
        console.log(`[WalletPool] Clearing ${this.wallets.length} wallets...`);
        
        // Create backup before clearing
        try {
            if (fs.existsSync(WALLETS_FILE)) {
                fs.copyFileSync(WALLETS_FILE, WALLETS_BACKUP + '.' + Date.now());
                console.log(`[WalletPool] Backup created before clear`);
            }
        } catch (e) {
            console.warn(`[WalletPool] Backup before clear failed: ${e.message}`);
        }
        
        this.wallets = [];
        this.publicKeyMap.clear();
        
        try {
            if (fs.existsSync(WALLETS_FILE)) fs.unlinkSync(WALLETS_FILE);
            console.log(`[WalletPool] wallets.json deleted`);
        } catch (e) {
            console.error(`⚠️ [WalletPool] Failed to delete wallets.json: ${e.message}`);
        }
    }

    /**
     * Remove specific wallet from pool by public key
     * 
     * @param {string} pubkeyBase58 - Public key to remove
     * @returns {boolean} True if wallet was found and removed
     */
    removeWallet(pubkeyBase58) {
        const wallet = this.publicKeyMap.get(pubkeyBase58);
        if (!wallet) return false;
        
        const index = this.wallets.findIndex(w => w.publicKey.toBase58() === pubkeyBase58);
        if (index === -1) return false;
        
        this.wallets.splice(index, 1);
        this.publicKeyMap.delete(pubkeyBase58);
        this._save();
        
        console.log(`[WalletPool] Removed wallet ${pubkeyBase58.slice(0,8)}...`);
        return true;
    }

    /**
     * Export wallet secret key for backup/transfer
     * 
     * @param {string} pubkeyBase58 - Public key of wallet to export
     * @returns {string|null} Base58-encoded secret key or null if not found
     */
    exportWallet(pubkeyBase58) {
        const wallet = this.publicKeyMap.get(pubkeyBase58);
        if (!wallet) return null;
        return bs58.encode(wallet.secretKey);
    }

    /**
     * Import a wallet from base58-encoded secret key
     * 
     * @param {string} secretKeyBase58 - Base58-encoded secret key
     * @returns {Keypair|null} The imported keypair or null if invalid
     */
    importWallet(secretKeyBase58) {
        try {
            const kp = Keypair.fromSecretKey(bs58.decode(secretKeyBase58));
            // Check if already exists
            if (this.hasWallet(kp.publicKey.toBase58())) {
                console.warn(`[WalletPool] Wallet ${kp.publicKey.toBase58().slice(0,8)}... already exists`);
                return kp;
            }
            this.wallets.push(kp);
            this.publicKeyMap.set(kp.publicKey.toBase58(), kp);
            this._save();
            console.log(`[WalletPool] Imported wallet ${kp.publicKey.toBase58().slice(0,8)}...`);
            return kp;
        } catch (e) {
            console.error(`[WalletPool] Failed to import wallet: ${e.message}`);
            return null;
        }
    }

    /**
     * Get pool statistics (no RPC calls)
     * 
     * @returns {{total: number, firstFew: string[]}}
     */
    getStats() {
        return {
            total: this.wallets.length,
            firstFew: this.wallets.slice(0, 3).map(w => w.publicKey.toBase58().substring(0, 8) + "..."),
            memoryEstimateKB: Math.round((this.wallets.length * 128) / 1024) // ~128 bytes per Keypair
        };
    }

    /**
     * Get detailed pool info including balance summary (requires RPC)
     * 
     * @param {Connection} connection - Solana connection
     * @returns {Promise<{total: number, totalSOL: number, avgBalance: number}>}
     */
    async getDetailedStats(connection) {
        const scan = await this.scanBalances(connection, 30);
        return {
            total: this.wallets.length,
            totalSOL: scan.totalSOL,
            avgBalance: this.wallets.length > 0 ? scan.totalSOL / this.wallets.length : 0,
            funded: scan.funded,
            empty: scan.empty
        };
    }

    // ─── Getters ───────────────────────────────────

    /**
     * Get number of wallets in pool
     * @returns {number}
     */
    get size() {
        return this.wallets.length;
    }

    /**
     * Get all wallet public keys as base58 strings
     * @returns {string[]}
     */
    get publicKeys() {
        return this.wallets.map(w => w.publicKey.toBase58());
    }

    /**
     * Get array of all Keypairs (read-only copy)
     * @returns {Keypair[]}
     */
    get allWallets() {
        return [...this.wallets];
    }
}

// ─── Module Exports ────────────────────────────────
export default WalletPool;
