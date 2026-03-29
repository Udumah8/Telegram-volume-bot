async function executeBullTrap(chatId, connection) {
    bot.sendMessage(chatId, `🐻 *BULL TRAP MANIPULATION*\nSimulating breakout then stealth dump...`, { parse_mode: 'Markdown' });

    const usePool = STATE.useWalletPool && walletPool.size > 0;
    const steps = Math.floor(getRandomFloat(4, 7));          // random number of buy steps (4–6)
    const trapWallet = usePool ? walletPool.getRandomSubset(1)[0] : masterKeypair;

    // 1. FAKE BREAKOUT – buys with random amounts, not strictly increasing
    let totalBought = 0;
    for (let i = 0; i < steps && STATE.running; i++) {
        // Random amount between minBuy and maxBuy, sometimes bigger for later steps
        let buyAmt;
        if (Math.random() < 0.3) {
            // occasional larger buy to mimic whale interest
            buyAmt = getRandomFloat(STATE.minBuyAmount * 1.5, STATE.maxBuyAmount * 2);
        } else {
            buyAmt = getRandomFloat(STATE.minBuyAmount, STATE.maxBuyAmount);
        }
        buyAmt = parseFloat(buyAmt.toFixed(4));
        
        bot.sendMessage(chatId, `📈 Bait Buy ${i+1}/${steps}: \`${buyAmt}\` SOL`, { parse_mode: 'Markdown' });
        const txid = await swap(SOL_ADDR, STATE.tokenAddress, trapWallet, connection, buyAmt, chatId, true);
        if (txid) totalBought += buyAmt;
        
        // Random delay between buys (1–4 seconds) + jitter
        const delay = getJitteredInterval(Math.floor(getRandomFloat(1000, 4000)), STATE.jitterPercentage);
        await sleep(delay);
    }

    if (!STATE.running) return;

    // 2. REALISTIC WAIT with micro‑sell distractions (simulate profit‑taking)
    const waitTime = getJitteredInterval(Math.floor(getRandomFloat(5000, 12000)), STATE.jitterPercentage);
    bot.sendMessage(chatId, `⏳ Waiting \`${Math.round(waitTime/1000)}s\` – other wallets may take profits...`, { parse_mode: 'Markdown' });
    
    const startWait = Date.now();
    while (Date.now() - startWait < waitTime && STATE.running) {
        // 20% chance to simulate a small sell from a different wallet during wait
        if (Math.random() < 0.2 && usePool && walletPool.size > 0) {
            const randomSeller = walletPool.getRandomSubset(1)[0];
            const tokenBal = await getTokenBalance(connection, randomSeller.publicKey, STATE.tokenAddress);
            if (tokenBal > 0.001) {
                const sellPct = getRandomFloat(0.1, 0.4); // sell 10-40% of holdings
                const sellAmt = parseFloat((tokenBal * sellPct).toFixed(6));
                await swap(STATE.tokenAddress, SOL_ADDR, randomSeller, connection, sellAmt, chatId, true);
                await sleep(getJitteredInterval(500, 20));
            }
        }
        await sleep(1000);
    }

    if (!STATE.running) return;

    // 3. STEALTH DUMP – split into random chunks to avoid a single whale signature
    const totalTokens = await getTokenBalance(connection, trapWallet.publicKey, STATE.tokenAddress);
    if (totalTokens <= 0) {
        bot.sendMessage(chatId, `⚠️ No tokens to dump. Bull trap aborted.`, { parse_mode: 'Markdown' });
        return;
    }

    const oldSlippage = STATE.slippage;
    STATE.slippage = STATE.bullTrapSlippage || 20;
    const chunks = Math.floor(getRandomFloat(2, 5)); // split into 2–4 sells
    const chunkSize = totalTokens / chunks;
    
    bot.sendMessage(chatId, `🔴 Dumping \`${totalTokens.toFixed(4)}\` tokens in ${chunks} stealth chunks (${STATE.slippage}% slippage)...`, { parse_mode: 'Markdown' });

    for (let c = 0; c < chunks && STATE.running; c++) {
        const amountToSell = (c === chunks - 1) ? 'auto' : chunkSize.toFixed(6);
        await swap(STATE.tokenAddress, SOL_ADDR, trapWallet, connection, amountToSell, chatId, true);
        if (c < chunks - 1) {
            // random delay between dumps (0.5–2 seconds) to avoid atomic pattern detection
            await sleep(getJitteredInterval(Math.floor(getRandomFloat(500, 2000)), STATE.jitterPercentage));
        }
    }

    STATE.slippage = oldSlippage;
    bot.sendMessage(chatId, `✅ Bull Trap Complete – tokens dumped in ${chunks} chunks.`, { parse_mode: 'Markdown' });
}
