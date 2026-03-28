import { Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import bs58 from "bs58";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WALLETS_FILE = path.join(__dirname, "wallets.json");

/**
 * WalletPool — Manages 10,000+ persistent Solana wallets.
 * 
 * Wallets are stored as JSON on disk and loaded into memory on boot.
 * All batch operations (fund, drain, balance scan) use configurable
 * concurrency to avoid RPC rate limits.
 */
export class WalletPool {
    constructor() {
        /** @type {Keypair[]} */
        this.wallets = [];
        this._load();
    }

    // ─── Persistence ───────────────────────────────

    _load() {
        try {
            if (fs.existsSync(WALLETS_FILE)) {
                const raw = JSON.parse(fs.readFileSync(WALLETS_FILE, "utf-8"));
                this.wallets = raw.map(w => Keypair.fromSecretKey(bs58.decode(w.secretKey)));
                console.log(`✅ [WalletPool] Loaded ${this.wallets.length} wallets from disk.`);
            }
        } catch (e) {
            console.error(`⚠️ [WalletPool] Failed to load wallets.json: ${e.message}`);
            this.wallets = [];
        }
    }

    _save() {
        const data = this.wallets.map(kp => ({
            publicKey: kp.publicKey.toBase58(),
            secretKey: bs58.encode(kp.secretKey)
        }));
        fs.writeFileSync(WALLETS_FILE, JSON.stringify(data), "utf-8");
    }

    // ─── Generation ────────────────────────────────

    /**
     * Generate `count` new wallets and append to the pool.
     * Generates in chunks to avoid blocking the event loop.
     */
    async generateWallets(count, progressCb = null) {
        const CHUNK = 500;
        let generated = 0;

        while (generated < count) {
            const batchSize = Math.min(CHUNK, count - generated);
            for (let i = 0; i < batchSize; i++) {
                this.wallets.push(Keypair.generate());
            }
            generated += batchSize;

            if (progressCb) progressCb({ generated, total: count });

            // Yield to event loop every chunk
            await new Promise(r => setImmediate(r));
        }

        this._save();
        return generated;
    }

    // ─── Batch Operations ──────────────────────────

    /**
     * Concurrency-limited async executor.
     * Runs `fn(item, index)` for each item with at most `concurrency` in flight.
     */
    async _batchExecute(items, fn, concurrency, progressCb = null, checkRunning = null) {
        let completed = 0;
        let successes = 0;
        let failures = 0;
        const total = items.length;
        let index = 0;

        const worker = async () => {
            while (index < total) {
                if (checkRunning && !checkRunning()) break;
                const i = index++;
                try {
                    await fn(items[i], i);
                    successes++;
                } catch (e) {
                    failures++;
                    console.error(`[WalletPool] Batch item ${i} error: ${e.message}`);
                }
                completed++;
                if (progressCb && (completed % Math.max(1, Math.floor(total / 20)) === 0 || completed === total)) {
                    progressCb({ completed, total, successes, failures });
                }
            }
        };

        const workers = Array.from({ length: Math.min(concurrency, total) }, () => worker());
        await Promise.all(workers);
        return { completed, successes, failures };
    }

    /**
     * Fund all wallets from a master keypair.
     * Skips wallets that already have >= amountSOL balance.
     */
    async fundAll(connection, masterKeypair, sendSOLFn, amountSOL, concurrency = 10, progressCb = null, checkRunning = null) {
        // First, scan which wallets need funding
        const walletsToFund = [];
        const scanResults = await this.scanBalances(connection, concurrency);

        for (let i = 0; i < this.wallets.length; i++) {
            const bal = scanResults.balances[i] || 0;
            if (bal < amountSOL * LAMPORTS_PER_SOL * 0.9) { // Allow 10% tolerance
                walletsToFund.push(this.wallets[i]);
            }
        }

        if (progressCb) progressCb({ completed: 0, total: walletsToFund.length, successes: 0, failures: 0, skipped: this.wallets.length - walletsToFund.length });

        return await this._batchExecute(
            walletsToFund,
            async (wallet) => {
                await sendSOLFn(connection, masterKeypair, wallet.publicKey, amountSOL);
            },
            concurrency,
            progressCb,
            checkRunning
        );
    }

    /**
     * Drain all wallets back to the master wallet.
     * Leaves 5000 lamports for rent-exemption.
     */
    async drainAll(connection, masterKeypair, sendSOLFn, concurrency = 10, progressCb = null, checkRunning = null) {
        return await this._batchExecute(
            this.wallets,
            async (wallet) => {
                const bal = await connection.getBalance(wallet.publicKey);
                const MIN_RENT = 5000;
                if (bal > MIN_RENT + 5000) { // Only drain if there's meaningful SOL
                    const drainAmount = (bal - MIN_RENT) / LAMPORTS_PER_SOL;
                    await sendSOLFn(connection, wallet, masterKeypair.publicKey, drainAmount);
                }
            },
            concurrency,
            progressCb,
            checkRunning
        );
    }

    /**
     * Scan balances of all wallets.
     * Returns {totalSOL, funded, empty, balances[]}
     */
    async scanBalances(connection, concurrency = 20) {
        const balances = new Array(this.wallets.length).fill(0);
        let totalSOL = 0;
        let funded = 0;
        let empty = 0;

        await this._batchExecute(
            this.wallets,
            async (wallet, i) => {
                try {
                    const bal = await connection.getBalance(wallet.publicKey);
                    balances[i] = bal;
                    totalSOL += bal / LAMPORTS_PER_SOL;
                    if (bal > 10000) funded++;
                    else empty++;
                } catch {
                    empty++;
                }
            },
            concurrency
        );

        return { totalSOL, funded, empty, balances };
    }

    // ─── Selection ─────────────────────────────────

    /**
     * Get a random subset of `count` wallets from the pool.
     * Uses Fisher-Yates partial shuffle for O(count) performance.
     */
    getRandomSubset(count) {
        const n = Math.min(count, this.wallets.length);
        const pool = [...this.wallets];
        for (let i = pool.length - 1; i > pool.length - 1 - n && i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [pool[i], pool[j]] = [pool[j], pool[i]];
        }
        return pool.slice(pool.length - n);
    }

    // ─── Management ────────────────────────────────

    /**
     * Clear all wallets from pool and delete the file.
     */
    clearAll() {
        this.wallets = [];
        try {
            if (fs.existsSync(WALLETS_FILE)) fs.unlinkSync(WALLETS_FILE);
        } catch (e) {
            console.error(`⚠️ [WalletPool] Failed to delete wallets.json: ${e.message}`);
        }
    }

    /**
     * Get pool statistics (no RPC calls).
     */
    getStats() {
        return {
            total: this.wallets.length,
            firstFew: this.wallets.slice(0, 3).map(w => w.publicKey.toBase58().substring(0, 8) + "..."),
        };
    }

    get size() {
        return this.wallets.length;
    }
}
