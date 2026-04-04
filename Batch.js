// batchEngine.js

/**
 * BatchSwapEngine — Concurrency-controlled batch swap executor.
 * 
 * Runs swap operations across many wallets with a configurable
 * concurrency limit to avoid RPC rate limits.
 * 
 * Features:
 * - Configurable concurrency with worker pool pattern
 * - Per-wallet rate limiting to avoid RPC spam
 * - Exponential backoff retry for transient errors
 * - Progress callbacks with throttled updates
 * - Cancellation support via checkRunning callback
 * - Non-robotic behavior: shuffling, jitter, variable delays
 * - Detailed result tracking per wallet
 */

/**
 * @typedef {Object} BatchProgress
 * @property {number} completed - Number of items processed
 * @property {number} total - Total items to process
 * @property {number} successes - Successful operations
 * @property {number} failures - Failed operations
 * @property {number} [percent] - Completion percentage (0-100)
 * @property {string} [elapsed] - Elapsed time string
 * @property {string} [rate] - Operations per second
 * @property {string} [eta] - Estimated time remaining
 */

/**
 * @typedef {Object} BatchResult
 * @property {number} completed - Total items attempted
 * @property {number} successes - Successful operations
 * @property {number} failures - Failed operations
 * @property {Array<*>} results - Array of results indexed by wallet
 */

export class BatchSwapEngine {
    
    /**
     * Execute an action function across a list of wallets with concurrency control.
     * 
     * @param {Object[]} wallets - Array of wallet Keypairs
     * @param {Function} actionFn - async (wallet, index) => Promise<result>
     * @param {number} concurrency - Max parallel executions (default 10)
     * @param {Function|null} progressCb - ({completed, total, successes, failures}) => void
     * @param {Function|null} checkRunning - () => boolean, checked before each execution
     * @param {Object} options - Additional options
     * @param {number} [options.maxRetries=2] - Max retry attempts for transient errors
     * @param {number} [options.minIntervalMs=100] - Minimum ms between calls per wallet
     * @param {boolean} [options.shuffle=true] - Shuffle wallet order for non-robotic behavior
     * @param {boolean} [options.perActionJitter=true] - Add random delay before each action
     * @param {number} [options.jitterMaxMs=400] - Max jitter delay in milliseconds
     * @returns {Promise<BatchResult>}
     */
    static async executeBatch(
        wallets, 
        actionFn, 
        concurrency = 10, 
        progressCb = null, 
        checkRunning = null,
        options = {}
    ) {
        // Validate inputs
        if (!Array.isArray(wallets) || wallets.length === 0) {
            console.warn('[BatchSwapEngine] executeBatch called with empty or invalid wallets array');
            return { completed: 0, successes: 0, failures: 0, results: [] };
        }
        if (typeof actionFn !== 'function') {
            throw new Error('[BatchSwapEngine] actionFn must be a function');
        }

        // Extract options with defaults
        const {
            maxRetries = 2,
            minIntervalMs = 100,
            shuffle = true,
            perActionJitter = true,
            jitterMaxMs = 400,
            initialWorkerJitter = true,
            initialJitterMaxMs = 800
        } = options;

        // State tracking
        let completed = 0;
        let successes = 0;
        let failures = 0;
        const total = wallets.length;
        const results = new Array(total).fill(null);
        let index = 0;
        const startTime = Date.now();

        // --- NON-ROBOTIC UPGRADE: SHUFFLE WALLETS ---
        // Shuffling ensures we don't always use the same wallets in the same order
        // This helps distribute load and avoid detectable patterns
        const executionOrder = shuffle 
            ? BatchSwapEngine._createShuffledIndices(total)
            : Array.from({ length: total }, (_, i) => i);

        // Report interval: throttle progress updates to avoid spam
        // Update every 5% or at minimum every 10 completions
        const reportEvery = Math.max(1, Math.min(10, Math.floor(total / 20)));

        // Per-wallet rate limiting map: tracks last call time per wallet pubkey
        const lastCallTime = new Map();

        /**
         * Worker function that processes items from the queue
         * @param {number} workerId - Unique identifier for this worker
         */
        const worker = async (workerId) => {
            // --- NON-ROBOTIC UPGRADE: INITIAL WORKER JITTER ---
            // Small random delay when worker starts to spread out the initial burst
            if (initialWorkerJitter && total > 1) {
                const initialDelay = Math.random() * initialJitterMaxMs;
                await new Promise(resolve => setTimeout(resolve, initialDelay));
            }

            while (true) {
                // Grab next index atomically (simple counter approach)
                const queueIndex = index++;
                if (queueIndex >= total) break;

                // Get the actual wallet index from our shuffled order
                const actualIndex = executionOrder[queueIndex];
                const wallet = wallets[actualIndex];
                const walletKey = wallet?.publicKey?.toBase58?.() || `wallet_${actualIndex}`;
                let lastError = null;

                // Check if bot is still running before proceeding
                if (checkRunning && !checkRunning()) {
                    console.debug(`[BatchEngine] Worker ${workerId} stopped: checkRunning returned false`);
                    break;
                }

                // --- RETRY LOOP FOR TRANSIENT ERRORS ---
                for (let attempt = 0; attempt <= maxRetries; attempt++) {
                    try {
                        // --- NON-ROBOTIC UPGRADE: PER-WALLET RATE LIMITING ---
                        // Ensure minimum interval between calls for same wallet
                        const lastTime = lastCallTime.get(walletKey) || 0;
                        const now = Date.now();
                        const elapsed = now - lastTime;
                        
                        if (elapsed < minIntervalMs) {
                            await new Promise(resolve => setTimeout(resolve, minIntervalMs - elapsed));
                        }
                        lastCallTime.set(walletKey, Date.now());

                        // --- NON-ROBOTIC UPGRADE: PER-ACTION JITTER ---
                        // Small random pause before each trade to mimic human behavior
                        if (perActionJitter && jitterMaxMs > 0) {
                            const jitterDelay = Math.random() * jitterMaxMs;
                            await new Promise(resolve => setTimeout(resolve, jitterDelay));
                        }

                        // Execute the actual action
                        const result = await actionFn(wallet, actualIndex);
                        
                        // Record result and count success
                        results[actualIndex] = result;
                        if (result !== null && result !== undefined) {
                            successes++;
                        } else {
                            // Null/undefined result may indicate skipped operation (not necessarily failure)
                            // Count as success since it didn't error
                            successes++;
                        }
                        
                        lastError = null;
                        break; // Success - exit retry loop
                        
                    } catch (err) {
                        lastError = err;
                        
                        // Determine if error is retryable
                        const isRetryable = BatchSwapEngine._isRetryableError(err);
                        
                        if (isRetryable && attempt < maxRetries) {
                            // Exponential backoff with jitter for retry delays
                            const baseDelay = 500 * Math.pow(2, attempt);
                            const jitter = baseDelay * 0.1 * Math.random();
                            const delay = Math.min(baseDelay + jitter, 3000);
                            
                            console.debug(
                                `[BatchEngine] Wallet ${actualIndex} (${walletKey.slice(0,8)}...) ` +
                                `retry ${attempt + 1}/${maxRetries} in ${Math.round(delay)}ms: ${err.message}`
                            );
                            
                            await new Promise(resolve => setTimeout(resolve, delay));
                            continue; // Retry the operation
                        }
                        
                        // Non-retryable error or max retries exceeded - exit retry loop
                        break;
                    }
                }

                // Record failure if all retries exhausted
                if (lastError) {
                    failures++;
                    console.error(
                        `[BatchEngine] Worker ${workerId} | Wallet ${actualIndex} ` +
                        `(${walletKey.slice(0,8)}...) failed after ${maxRetries} retries: ${lastError.message}`
                    );
                }

                // Update completion counters
                completed++;

                // --- PROGRESS CALLBACK WITH THROTTLING ---
                if (progressCb && (completed % reportEvery === 0 || completed === total)) {
                    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                    const rate = (completed / (Date.now() - startTime) * 1000).toFixed(1);
                    const remaining = total - completed;
                    const eta = remaining > 0 && completed > 0 
                        ? Math.round((remaining / completed) * (Date.now() - startTime) / 1000)
                        : 0;
                    
                    progressCb({ 
                        completed, 
                        total, 
                        successes, 
                        failures,
                        percent: Math.round((completed / total) * 100),
                        elapsed: `${elapsed}s`,
                        rate: `${rate}/s`,
                        eta: eta > 0 ? `${eta}s` : 'done'
                    });
                }
            }
        };

        // --- SPAWN WORKER POOL ---
        // Create up to `concurrency` workers, but not more than total items
        const workerCount = Math.min(concurrency, total);
        const workers = Array.from(
            { length: workerCount },
            (_, workerId) => worker(workerId)
        );
        
        // Wait for all workers to complete
        await Promise.all(workers);

        // Log final summary
        const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
        const successRate = total > 0 ? ((successes / total) * 100).toFixed(1) : 0;
        console.log(
            `[BatchSwapEngine] Batch complete: ${successes}/${total} succeeded ` +
            `(${successRate}%), ${failures} failed in ${totalTime}s`
        );

        return { completed, successes, failures, results };
    }

    /**
     * Execute buy+sell cycle across wallets in a single batch.
     * Each wallet buys, waits with variable delay, then sells.
     * 
     * @param {Object[]} wallets - Array of wallet Keypairs
     * @param {Function} swapFn - async (tokenIn, tokenOut, wallet, connection, amount, chatId, silent) => Promise<txid>
     * @param {string} tokenAddress - Target token mint address
     * @param {string} solAddr - SOL mint address (usually "So11111111111111111111111111111111111111112")
     * @param {Object} connection - Solana Connection instance
     * @param {Function} getAmountFn - Function that returns buy amount for each wallet
     * @param {number} concurrency - Max parallel buy-sell cycles
     * @param {Function|null} progressCb - Progress callback
     * @param {Function|null} checkRunning - Cancellation check function
     * @param {Object} options - Additional options for executeBatch
     * @returns {Promise<BatchResult>}
     */
    static async executeBuySellCycle(
        wallets, 
        swapFn, 
        tokenAddress, 
        solAddr, 
        connection, 
        getAmountFn, 
        concurrency = 10, 
        progressCb = null, 
        checkRunning = null,
        options = {}
    ) {
        return await BatchSwapEngine.executeBatch(
            wallets,
            async (wallet, i) => {
                // Check running status before starting cycle
                if (checkRunning && !checkRunning()) return null;

                // Get dynamic amount for this wallet
                const amount = getAmountFn(wallet, i);

                try {
                    // --- BUY PHASE ---
                    const buyResult = await swapFn(
                        solAddr,           // tokenIn: SOL
                        tokenAddress,      // tokenOut: target token
                        wallet, 
                        connection, 
                        amount, 
                        null,              // chatId (not used in batch mode)
                        true               // silent: suppress individual notifications
                    );
                    
                    // If buy failed, skip sell
                    if (!buyResult) {
                        console.warn(`[BuySellCycle] Wallet ${i} buy failed, skipping sell`);
                        return { buy: null, sell: null, error: 'buy_failed' };
                    }

                    // --- NON-ROBOTIC UPGRADE: DYNAMIC HOLD DELAYS ---
                    // Variable delay between buy and sell to mimic human behavior
                    // Base range: 1.2s to 5.0s, with additional randomness
                    const baseDelay = 1200;
                    const maxDelay = 3800;
                    const holdDelay = baseDelay + Math.random() * maxDelay;
                    
                    // Optional: add rare "deep think" delays (5% chance of 10-30s pause)
                    if (Math.random() < 0.05) {
                        const deepThinkDelay = 10000 + Math.random() * 20000;
                        console.debug(`[BuySellCycle] Wallet ${i} deep think: +${Math.round(deepThinkDelay/1000)}s`);
                        await new Promise(resolve => setTimeout(resolve, deepThinkDelay));
                    }
                    
                    await new Promise(resolve => setTimeout(resolve, holdDelay));

                    // --- SELL PHASE ---
                    // Sell all tokens ('auto' amount)
                    const sellResult = await swapFn(
                        tokenAddress,      // tokenIn: target token
                        solAddr,           // tokenOut: SOL
                        wallet, 
                        connection, 
                        'auto',            // Sell entire balance
                        null, 
                        true
                    );

                    return { 
                        buy: buyResult, 
                        sell: sellResult,
                        holdTime: holdDelay
                    };
                    
                } catch (err) {
                    console.error(`[BuySellCycle] Wallet ${i} cycle error: ${err.message}`);
                    throw err; // Re-throw to be handled by executeBatch retry logic
                }
            },
            concurrency,
            progressCb,
            checkRunning,
            {
                // Default options optimized for buy-sell cycles
                maxRetries: 2,
                minIntervalMs: 150, // Slightly longer interval for two-step operations
                shuffle: true,
                perActionJitter: true,
                jitterMaxMs: 300,
                ...options // Allow caller to override defaults
            }
        );
    }

    /**
     * Execute sequential (non-parallel) operations across wallets.
     * Useful for operations that must happen in order or when RPC limits are very strict.
     * 
     * @param {Object[]} wallets - Array of wallet Keypairs
     * @param {Function} actionFn - async (wallet, index) => Promise<result>
     * @param {Function|null} progressCb - Progress callback
     * @param {Function|null} checkRunning - Cancellation check
     * @param {Object} options - Additional options
     * @returns {Promise<BatchResult>}
     */
    static async executeSequential(
        wallets, 
        actionFn, 
        progressCb = null, 
        checkRunning = null,
        options = {}
    ) {
        const {
            minDelayMs = 200,
            maxDelayMs = 800,
            shuffle = true
        } = options;

        if (!Array.isArray(wallets) || wallets.length === 0) {
            return { completed: 0, successes: 0, failures: 0, results: [] };
        }

        let successes = 0;
        let failures = 0;
        const total = wallets.length;
        const results = new Array(total).fill(null);
        const startTime = Date.now();

        // Optional shuffle for non-robotic ordering
        const executionOrder = shuffle 
            ? BatchSwapEngine._createShuffledIndices(total)
            : Array.from({ length: total }, (_, i) => i);

        for (let queueIdx = 0; queueIdx < total; queueIdx++) {
            const actualIndex = executionOrder[queueIdx];
            const wallet = wallets[actualIndex];

            // Check cancellation
            if (checkRunning && !checkRunning()) {
                console.log('[BatchSwapEngine] Sequential execution cancelled');
                break;
            }

            // Variable delay between sequential operations
            const delay = minDelayMs + Math.random() * (maxDelayMs - minDelayMs);
            await new Promise(resolve => setTimeout(resolve, delay));

            try {
                const result = await actionFn(wallet, actualIndex);
                results[actualIndex] = result;
                if (result !== null && result !== undefined) {
                    successes++;
                } else {
                    successes++; // Null result = skipped, not failed
                }
            } catch (err) {
                failures++;
                console.error(`[BatchSwapEngine] Sequential wallet ${actualIndex} error: ${err.message}`);
            }

            // Progress callback
            const completed = queueIdx + 1;
            if (progressCb && (completed % Math.max(1, Math.floor(total / 10)) === 0 || completed === total)) {
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                progressCb({ 
                    completed, 
                    total, 
                    successes, 
                    failures,
                    percent: Math.round((completed / total) * 100),
                    elapsed: `${elapsed}s`
                });
            }
        }

        return { completed: successes + failures, successes, failures, results };
    }

    /**
     * Execute batch with weighted priority: some wallets get processed first.
     * Useful for strategies that need certain wallets to act before others.
     * 
     * @param {Object[]} wallets - Array of wallet Keypairs
     * @param {Function} actionFn - async (wallet, index) => Promise<result>
     * @param {number[]} priorities - Array of priority weights (higher = earlier)
     * @param {number} concurrency - Max parallel executions
     * @param {Function|null} progressCb - Progress callback
     * @param {Function|null} checkRunning - Cancellation check
     * @returns {Promise<BatchResult>}
     */
    static async executeWeighted(
        wallets, 
        actionFn, 
        priorities, 
        concurrency = 10, 
        progressCb = null, 
        checkRunning = null
    ) {
        if (!Array.isArray(wallets) || wallets.length === 0) {
            return { completed: 0, successes: 0, failures: 0, results: [] };
        }
        if (priorities.length !== wallets.length) {
            throw new Error('[BatchSwapEngine] priorities array must match wallets length');
        }

        // Create weighted execution order using priority-based shuffle
        const weightedOrder = BatchSwapEngine._createWeightedOrder(wallets.length, priorities);

        // Use executeBatch with pre-shuffled order by wrapping actionFn
        return await BatchSwapEngine.executeBatch(
            wallets,
            async (wallet, originalIndex) => {
                // The actual execution index is mapped through weightedOrder
                const executionIndex = weightedOrder[originalIndex];
                return await actionFn(wallet, executionIndex);
            },
            concurrency,
            progressCb,
            checkRunning,
            { shuffle: false } // We already shuffled via weighted order
        );
    }

    // ─── Private Helper Methods ──────────────────────────

    /**
     * Create shuffled indices array using Fisher-Yates algorithm
     * @param {number} length - Number of indices
     * @returns {number[]} Shuffled array [0, 1, 2, ..., length-1]
     */
    static _createShuffledIndices(length) {
        const indices = Array.from({ length }, (_, i) => i);
        for (let i = indices.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [indices[i], indices[j]] = [indices[j], indices[i]];
        }
        return indices;
    }

    /**
     * Create execution order weighted by priority values
     * Higher priority = more likely to appear earlier in order
     * @param {number} length - Number of items
     * @param {number[]} priorities - Array of priority weights
     * @returns {number[]} Weighted execution order
     */
    static _createWeightedOrder(length, priorities) {
        // Create array of {index, priority} objects
        const items = priorities.map((priority, index) => ({ index, priority }));
        
        // Sort by priority descending with some randomness for ties
        items.sort((a, b) => {
            const diff = b.priority - a.priority;
            if (Math.abs(diff) < 0.01) {
                // Near-equal priorities: randomize order
                return Math.random() - 0.5;
            }
            return diff;
        });
        
        // Extract just the indices in sorted order
        return items.map(item => item.index);
    }

    /**
     * Determine if an error is retryable (transient network/RPC issue)
     * @param {Error} err - The error to evaluate
     * @returns {boolean} True if error should trigger retry
     */
    static _isRetryableError(err) {
        if (!err || !err.message) return false;
        
        const message = err.message.toLowerCase();
        const code = err.code?.toString?.().toLowerCase() || '';
        
        // Network/timeout errors
        if (message.includes('timeout') || 
            message.includes('timed out') ||
            code === 'etimedout' ||
            code === 'econnreset' ||
            code === 'econnrefused') {
            return true;
        }
        
        // Rate limiting errors
        if (message.includes('429') || 
            message.includes('rate limit') ||
            message.includes('too many requests') ||
            message.includes('throttl')) {
            return true;
        }
        
        // Solana-specific transient errors
        if (message.includes('blockhash') ||
            message.includes('transaction was not confirmed') ||
            message.includes('failed to get') ||
            message.includes('node is behind') ||
            message.includes('slot not available')) {
            return true;
        }
        
        // RPC response errors that may be transient
        if (message.includes('send transaction error') ||
            message.includes('connection refused') ||
            message.includes('network error')) {
            return true;
        }
        
        // Default: not retryable
        return false;
    }

    /**
     * Sleep helper with optional jitter
     * @param {number} minMs - Minimum delay in milliseconds
     * @param {number} [maxMs] - Maximum delay (if provided, adds jitter)
     * @returns {Promise<void>}
     */
    static async sleep(minMs, maxMs = null) {
        const delay = maxMs !== null 
            ? minMs + Math.random() * (maxMs - minMs)
            : minMs;
        return new Promise(resolve => setTimeout(resolve, delay));
    }
}

// ─── Module Exports ────────────────────────────────
export default BatchSwapEngine;
