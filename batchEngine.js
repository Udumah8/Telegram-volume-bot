/**
 * BatchSwapEngine — Concurrency-controlled batch swap executor.
 * 
 * Runs swap operations across many wallets with a configurable
 * concurrency limit to avoid RPC rate limits.
 */
export class BatchSwapEngine {
    /**
     * Execute an action function across a list of wallets with concurrency control.
     * 
     * @param {Object[]} wallets - Array of wallet Keypairs
     * @param {Function} actionFn - async (wallet, index) => result
     * @param {number} concurrency - Max parallel executions (default 10)
     * @param {Function|null} progressCb - ({completed, total, successes, failures}) => void
     * @param {Function|null} checkRunning - () => boolean, checked before each execution
     * @returns {Promise<{completed, successes, failures, results}>}
     */
    static async executeBatch(wallets, actionFn, concurrency = 10, progressCb = null, checkRunning = null) {
        let completed = 0;
        let successes = 0;
        let failures = 0;
        const total = wallets.length;
        const results = new Array(total).fill(null);
        let index = 0;

        // Report interval: every 5% or at minimum every 10 completions
        const reportEvery = Math.max(1, Math.min(10, Math.floor(total / 20)));

        const worker = async () => {
            while (true) {
                // Grab next index atomically
                const i = index++;
                if (i >= total) break;

                // Check if bot is still running
                if (checkRunning && !checkRunning()) break;

                try {
                    const result = await actionFn(wallets[i], i);
                    results[i] = result;
                    if (result !== null && result !== undefined) successes++;
                    else failures++;
                } catch (e) {
                    failures++;
                    console.error(`[BatchEngine] Wallet ${i} error: ${e.message}`);
                }

                completed++;

                if (progressCb && (completed % reportEvery === 0 || completed === total)) {
                    progressCb({ completed, total, successes, failures });
                }
            }
        };

        // Spawn `concurrency` workers
        const workers = Array.from(
            { length: Math.min(concurrency, total) },
            () => worker()
        );
        await Promise.all(workers);

        return { completed, successes, failures, results };
    }

    /**
     * Execute buy+sell cycle across wallets in a single batch.
     * Each wallet buys, waits, then sells.
     */
    static async executeBuySellCycle(wallets, swapFn, tokenAddress, solAddr, connection, getAmountFn, concurrency = 10, progressCb = null, checkRunning = null) {
        return await BatchSwapEngine.executeBatch(
            wallets,
            async (wallet, i) => {
                if (checkRunning && !checkRunning()) return null;

                const amount = getAmountFn();

                // Buy
                const buyResult = await swapFn(solAddr, tokenAddress, wallet, connection, amount, null, true);
                if (!buyResult) return null;

                // Small delay between buy and sell
                await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));

                // Sell all
                const sellResult = await swapFn(tokenAddress, solAddr, wallet, connection, 'auto', null, true);
                return { buy: buyResult, sell: sellResult };
            },
            concurrency,
            progressCb,
            checkRunning
        );
    }
}
