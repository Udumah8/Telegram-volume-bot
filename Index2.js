import fs from 'fs';
if (fs.existsSync('.env')) {
    const envConfig = fs.readFileSync('.env', 'utf-8');
    envConfig.split('\n').forEach(line => {
        const match = line.match(/^\s*([^#=]+?)\s*=\s*(.*)$/);
        if (match) process.env[match[1]] = match[2];
    });
}
import { Connection, Keypair, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { SolanaTracker } from "solana-swap";
let SolanaTrade; 
try {
    const stModule = await import("solana-trade");
    SolanaTrade = stModule.SolanaTrade;
} catch (e) {
    console.warn("⚠️ SolanaTrade provider failed to load. Using SolanaTracker as fallback.");
}
import { Buffer } from "buffer";
import bs58 from "bs58";
import TelegramBot from "node-telegram-bot-api";
import { sendJitoBundle } from "./jito.js";
import { WalletPool } from "./walletManager.js";
import { BatchSwapEngine } from "./batchEngine.js";
import winston from 'winston';

// ---------- Logger ----------
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}]: ${message}`)
    ),
    transports: [
        new winston.transports.File({ filename: 'bot.log', maxsize: 5242880, maxFiles: 5 }),
        new winston.transports.Console()
    ]
});

// ---------- RPC Fallback ----------
const RPC_URLS = process.env.RPC_URLS ? process.env.RPC_URLS.split(',') : [process.env.RPC_URL || "https://api.mainnet-beta.solana.com"];
let currentRpcIndex = 0;
function getConnection() {
    const url = RPC_URLS[currentRpcIndex % RPC_URLS.length];
    return new Connection(url);
}
async function withRpcFallback(fn) {
    for (let attempt = 0; attempt < RPC_URLS.length; attempt++) {
        try {
            return await fn(getConnection());
        } catch (err) {
            logger.error(`RPC ${RPC_URLS[currentRpcIndex]} failed: ${err.message}`);
            currentRpcIndex++;
        }
    }
    throw new Error("All RPC endpoints failed");
}

// ---------- Config ----------
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

if (!TELEGRAM_TOKEN) {
    logger.error("Missing TELEGRAM_TOKEN in .env");
    process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Master wallet
let masterKeypair = null;
if (process.env.PRIVKEY) {
    try {
        if (process.env.PRIVKEY.includes('[')) {
            masterKeypair = Keypair.fromSecretKey(Buffer.from(JSON.parse(process.env.PRIVKEY)));
        } else {
            masterKeypair = Keypair.fromSecretKey(bs58.decode(process.env.PRIVKEY));
        }
        logger.info(`Master Wallet loaded: ${masterKeypair.publicKey.toBase58()}`);
    } catch (e) {
        logger.error(`Failed to load master wallet: ${e.message}`);
    }
} else {
    logger.warn("No PRIVKEY in .env — wallet operations disabled.");
}

const SOL_ADDR = "So11111111111111111111111111111111111111112";
const walletPool = new WalletPool();
logger.info(`Wallet Pool: ${walletPool.size} wallets loaded.`);

// ---------- User session state for prompts ----------
const userSessions = new Map(); // chatId -> { action, timeout, callback }

function clearSession(chatId) {
    const session = userSessions.get(chatId);
    if (session) {
        clearTimeout(session.timeout);
        userSessions.delete(chatId);
    }
}

// Single message handler for prompts
bot.on('message', (msg) => {
    const chatId = msg.chat.id.toString();
    const session = userSessions.get(chatId);
    if (!session) return;
    if (msg.text && msg.text.startsWith('/')) return;
    clearTimeout(session.timeout);
    userSessions.delete(chatId);
    session.callback(msg.text.trim());
});

function promptSetting(chatId, prompt, callback) {
    clearSession(chatId);
    bot.sendMessage(chatId, prompt, { parse_mode: "Markdown", reply_markup: { force_reply: true } });
    const timeout = setTimeout(() => {
        if (userSessions.has(chatId)) {
            userSessions.delete(chatId);
            bot.sendMessage(chatId, "⏰ Prompt timed out. Please try again.");
        }
    }, 60000);
    userSessions.set(chatId, { action: 'prompt', timeout, callback });
}

// ---------- Rate limiting ----------
const lastCommandTime = new Map();
function isRateLimited(chatId) {
    const now = Date.now();
    const last = lastCommandTime.get(chatId) || 0;
    if (now - last < 2000) return true;
    lastCommandTime.set(chatId, now);
    return false;
}

// ---------- Constants & State ----------
const PERSONALITIES = {
    DIAMOND: { buyProb: 0.8, sellProb: 0.1, minHold: 5, maxHold: 15, sizeMult: 0.8 },
    SCALPER: { buyProb: 0.9, sellProb: 0.8, minHold: 1, maxHold: 3, sizeMult: 1.2 },
    RETAIL:  { buyProb: 0.5, sellProb: 0.4, minHold: 2, maxHold: 6, sizeMult: 0.5 },
    WHALE:   { buyProb: 0.3, sellProb: 0.05, minHold: 10, maxHold: 30, sizeMult: 3.0 }
};

const STATE = {
    tokenAddress: "",
    strategy: "STANDARD",
    minBuyAmount: 0.0100,
    maxBuyAmount: 0.0500,
    priorityFee: 0.0005,
    slippage: 2,
    numberOfCycles: 3,
    maxSimultaneousBuys: 1,
    maxSimultaneousSells: 1,
    intervalBetweenActions: 15000,
    jitterPercentage: 20,
    realismMode: true,
    humanizedDelays: true,
    variableSlippage: true,
    usePoissonTiming: true,
    useJito: false,
    jitoTipAmount: 0.0001,
    makerWalletsToGenerate: 3,
    makerFundingChainDepth: 2,      // max hops for stealth funding
    useWebFunding: true,            // master switch for advanced funding
    fundingStealthLevel: 2,         // 1 = direct (fast, traceable), 2 = multi-hop with drain (stealth, safe)
    personalityMix: ["DIAMOND", "SCALPER", "RETAIL"],
    useVolumeCurve: true,
    volCurveIntensity: 1.5,
    spamMicroBuyAmount: 0.0001,
    swapProvider: "SOLANA_TRACKER",
    targetDex: "RAYDIUM_AMM",
    chartPattern: "ASCENDING",
    holderWallets: 5,
    holderBuyAmount: 0.005,
    whaleBuyAmount: 1.0,
    whaleSellPercent: 80,
    volumeBoostMultiplier: 3,
    volumeBoostCycles: 10,
    volumeBoostMinAmount: 0.005,
    volumeBoostMaxAmount: 0.02,
    trendingMode: "VIRAL_PUMP",
    trendingIntensity: 5,
    kolRetailSwarmSize: 15,
    airdropWalletCount: 50,
    bullTrapSlippage: 15,
    walletPoolSize: 100,
    batchConcurrency: 10,
    walletsPerCycle: 50,
    fundAmountPerWallet: 0.01,
    useWalletPool: true,
    running: false
};

// ---------- Validation helpers ----------
function validateNumber(val, min, max, name) {
    const num = parseFloat(val);
    if (isNaN(num)) throw new Error(`${name} must be a number`);
    if (num < min || num > max) throw new Error(`${name} must be between ${min} and ${max}`);
    return num;
}

// ---------- Utilities ----------
function isAdmin(chatId) {
    if (!ADMIN_CHAT_ID) return true;
    return chatId.toString() === ADMIN_CHAT_ID.toString();
}

function getRandomFloat(min, max) {
    return Math.random() * (max - min) + min;
}

function getJitteredInterval(baseInterval, jitterPercent) {
    if (jitterPercent <= 0) return baseInterval;
    const variation = baseInterval * (jitterPercent / 100);
    let interval = Math.floor(getRandomFloat(baseInterval - variation, baseInterval + variation));
    if (STATE.realismMode && STATE.humanizedDelays && Math.random() < 0.10) {
        const distractionTime = Math.floor(getRandomFloat(5000, 15000));
        logger.info(`[Realism] Human distraction +${distractionTime}ms`);
        interval += distractionTime;
    }
    return interval;
}

function getDynamicSlippage(baseSlippage) {
    if (!STATE.realismMode || !STATE.variableSlippage) return baseSlippage;
    const variance = (Math.random() * 2) - 1;
    return Math.max(0.5, parseFloat((baseSlippage + variance).toFixed(1)));
}

function getDynamicFee(baseFee) {
    if (!STATE.realismMode) return baseFee;
    const variance = baseFee * ((Math.random() * 0.4) - 0.2);
    return Math.max(0.00001, parseFloat((baseFee + variance).toFixed(6)));
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function getPoissonDelay(mean) {
    if (!STATE.usePoissonTiming) return mean;
    return Math.floor(-mean * Math.log(1.0 - Math.random()));
}

function getVolumeMultiplier() {
    if (!STATE.useVolumeCurve) return 1.0;
    const now = new Date();
    const hours = now.getHours() + now.getMinutes() / 60;
    const wave = Math.sin((hours - 10) * (Math.PI / 12));
    const multiplier = 1.0 + (wave * 0.5 * STATE.volCurveIntensity);
    const noise = (Math.random() * 0.4 - 0.2) * STATE.volCurveIntensity;
    return Math.max(0.1, multiplier + noise);
}

// ---------- SAFE STEALTH FUNDING (multi-hop with drain) ----------
async function fundWebSafe(connection, from, targets, amountSOL, chatId) {
    const maxDepth = STATE.makerFundingChainDepth;
    const allIntermediates = [];

    bot.sendMessage(chatId, `🕸️ *Stealth Web Funding* for ${targets.length} wallets (max depth ${maxDepth})...`, { parse_mode: 'Markdown' });

    for (let i = 0; i < targets.length && STATE.running; i++) {
        const target = targets[i];
        const depth = Math.floor(getRandomFloat(1, maxDepth + 1));
        const path = [from];
        const intermediatesThisPath = [];

        for (let d = 0; d < depth; d++) {
            const inter = Keypair.generate();
            path.push(inter);
            intermediatesThisPath.push(inter);
            allIntermediates.push(inter);
        }
        path.push(target);

        bot.sendMessage(chatId, `🕸️ Path ${i+1}: ${depth} hops → ${target.publicKey.toBase58().substring(0,4)}...`);

        let currentAmount = amountSOL + (0.005 * depth);

        for (let j = 0; j < path.length - 1; j++) {
            if (!STATE.running) break;
            const sender = path[j];
            const receiver = path[j + 1];
            try {
                const txid = await sendSOL(connection, sender, receiver.publicKey, currentAmount);
                logger.info(`[StealthFund] ${sender.publicKey.toBase58().substring(0,4)} → ${receiver.publicKey.toBase58().substring(0,4)} | tx: ${txid}`);
            } catch (err) {
                bot.sendMessage(chatId, `⚠️ Funding break at hop ${j}: ${err.message}`);
                break;
            }
            currentAmount -= 0.004;
            await sleep(getPoissonDelay(2000));
        }
        await sleep(getPoissonDelay(3000));
    }

    // Drain all intermediate wallets
    if (allIntermediates.length > 0) {
        bot.sendMessage(chatId, `🧹 Draining ${allIntermediates.length} intermediate wallets...`);
        for (const inter of allIntermediates) {
            if (!STATE.running) break;
            try {
                const bal = await connection.getBalance(inter.publicKey);
                if (bal > 10000) {
                    await sendSOL(connection, inter, from.publicKey, (bal - 10000) / LAMPORTS_PER_SOL);
                    await sleep(500);
                }
            } catch (err) {
                logger.error(`Drain intermediate error: ${err.message}`);
            }
        }
    }
    bot.sendMessage(chatId, `✅ Stealth funding complete. Intermediates drained.`);
}

async function fundWalletsDirect(connection, from, targets, amountSOL, chatId) {
    bot.sendMessage(chatId, `💰 Direct funding ${targets.length} wallets with ${amountSOL} SOL each...`);
    for (let i = 0; i < targets.length && STATE.running; i++) {
        const target = targets[i];
        try {
            await sendSOL(connection, from, target.publicKey, amountSOL);
            await sleep(getPoissonDelay(1000));
        } catch (err) {
            bot.sendMessage(chatId, `⚠️ Funding failed for wallet ${i+1}: ${err.message}`);
        }
    }
    bot.sendMessage(chatId, `✅ Direct funding complete.`);
}

async function fundWallets(connection, from, targets, amountSOL, chatId) {
    if (STATE.useWebFunding && STATE.fundingStealthLevel === 2) {
        await fundWebSafe(connection, from, targets, amountSOL, chatId);
    } else {
        await fundWalletsDirect(connection, from, targets, amountSOL, chatId);
    }
}

// ---------- Balance check before transfer ----------
async function sendSOL(connection, from, to, amountSOL) {
    const balance = await connection.getBalance(from.publicKey);
    const requiredLamports = Math.floor(amountSOL * LAMPORTS_PER_SOL) + 5000;
    if (balance < requiredLamports) {
        throw new Error(`Insufficient balance: ${balance / LAMPORTS_PER_SOL} SOL, need ${amountSOL + 0.000005} SOL`);
    }
    const tx = new Transaction().add(
        SystemProgram.transfer({
            fromPubkey: from.publicKey,
            toPubkey: to,
            lamports: Math.floor(amountSOL * LAMPORTS_PER_SOL)
        })
    );
    if (STATE.useJito) {
        tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
        tx.feePayer = from.publicKey;
        tx.sign(from);
        const b58Tx = bs58.encode(tx.serialize());
        return await sendJitoBundle([b58Tx], from, connection, STATE.jitoTipAmount);
    } else {
        tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        tx.feePayer = from.publicKey;
        tx.sign(from);
        const txid = await connection.sendRawTransaction(tx.serialize());
        await connection.confirmTransaction(txid, 'finalized');
        return txid;
    }
}

async function getTokenBalance(connection, owner, tokenAddr) {
    try {
        const result = await connection.getTokenAccountsByOwner(owner, { mint: new PublicKey(tokenAddr) });
        if (result.value.length === 0) return 0;
        const info = await connection.getTokenAccountBalance(result.value[0].pubkey);
        return info.value.uiAmount || 0;
    } catch (error) { return 0; }
}

async function swap(tokenIn, tokenOut, keypair, connection, amount, chatId, silent = false) {
    try {
        let cleanAmount;
        if (typeof amount === 'string' && amount === 'auto') {
            cleanAmount = 'auto';
        } else {
            cleanAmount = parseFloat(parseFloat(amount).toFixed(6));
            if (isNaN(cleanAmount) || cleanAmount <= 0) throw new Error(`Invalid amount: ${amount}`);
        }

        const isBuy = tokenIn === SOL_ADDR;
        if (isBuy && cleanAmount !== 'auto') {
            const requiredSol = cleanAmount + (cleanAmount * STATE.slippage / 100) + STATE.priorityFee + (STATE.useJito ? STATE.jitoTipAmount : 0);
            const balance = await connection.getBalance(keypair.publicKey) / LAMPORTS_PER_SOL;
            if (balance < requiredSol) {
                throw new Error(`Insufficient SOL: ${balance.toFixed(6)} < ${requiredSol.toFixed(6)}`);
            }
        }

        const currentSlippage = getDynamicSlippage(STATE.slippage);
        const currentFee = getDynamicFee(STATE.priorityFee);

        if (STATE.swapProvider === "SOLANA_TRADE") {
            if (!SolanaTrade) throw new Error("SolanaTrade not loaded");
            const trade = new SolanaTrade(RPC_URLS[0]);
            const params = {
                market: STATE.targetDex,
                wallet: keypair,
                mint: isBuy ? tokenOut : tokenIn,
                amount: cleanAmount === 'auto' ? (await getTokenBalance(connection, keypair.publicKey, isBuy ? tokenOut : tokenIn)) : cleanAmount,
                slippage: currentSlippage,
                priorityFeeSol: STATE.useJito ? 0 : currentFee,
                tipAmountSol: STATE.useJito ? STATE.jitoTipAmount : 0,
                sender: STATE.useJito ? 'JITO' : undefined,
                skipConfirmation: STATE.useJito,
                send: true
            };
            if (!silent) bot.sendMessage(chatId, `⚡ ${STATE.targetDex} ${isBuy?'Buy':'Sell'}...`);
            const sig = isBuy ? await trade.buy(params) : await trade.sell(params);
            if (!silent && sig) bot.sendMessage(chatId, `✅ [Tx](https://solscan.io/tx/${sig})`, { parse_mode: 'Markdown' });
            return sig;
        } else {
            const solanaTracker = new SolanaTracker(keypair, RPC_URLS[0]);
            const swapResponse = await solanaTracker.getSwapInstructions(
                tokenIn, tokenOut, cleanAmount, currentSlippage, keypair.publicKey.toBase58(), STATE.useJito ? 0 : currentFee, false
            );
            if (!swapResponse || (!swapResponse.txn && !swapResponse.tx)) throw new Error('No transaction from API');
            let txid;
            if (STATE.useJito) {
                const serializedTx = swapResponse.txn || swapResponse.tx;
                let b58Tx = typeof serializedTx === 'string' ? serializedTx : bs58.encode(Buffer.from(serializedTx, 'base64'));
                txid = await sendJitoBundle([b58Tx], keypair, connection, STATE.jitoTipAmount);
            } else {
                txid = await solanaTracker.performSwap(swapResponse, {
                    sendOptions: { skipPreflight: false },
                    commitment: "finalized",
                });
            }
            if (!silent && txid) bot.sendMessage(chatId, `✅ [Tx](https://solscan.io/tx/${txid})`, { parse_mode: 'Markdown' });
            return txid;
        }
    } catch (e) {
        const errorMsg = e.message || "Unknown error";
        const shortKey = keypair.publicKey.toBase58().substring(0, 8);
        logger.error(`Swap error [${shortKey}]: ${errorMsg}`);
        if (!silent) bot.sendMessage(chatId, `⚠️ Swap failed [${shortKey}...]: ${errorMsg}`);
        return null;
    }
}

async function drainWallets(connection, wallets, masterPubkey, chatId) {
    for (const w of wallets) {
        if (!STATE.running) break;
        try {
            const bal = await connection.getBalance(w.publicKey);
            if (bal > 10000) {
                await sendSOL(connection, w, masterPubkey, (bal - 10000) / LAMPORTS_PER_SOL);
                await sleep(500);
            }
        } catch (err) {
            logger.error(`Drain error: ${err.message}`);
        }
    }
}

// ---------- Strategy Implementations ----------
async function executeStandardCycles(chatId, connection) {
    const usePool = STATE.useWalletPool && walletPool.size > 0;
    const walletCount = usePool ? Math.min(STATE.walletsPerCycle, walletPool.size) : STATE.maxSimultaneousBuys;
    bot.sendMessage(chatId, `📈 *Standard Mode*\n${usePool ? `Using ${walletCount} pool wallets` : `Using master wallet`}...`, { parse_mode: 'Markdown' });

    for (let i = 0; i < STATE.numberOfCycles && STATE.running; i++) {
        const volMult = getVolumeMultiplier();
        bot.sendMessage(chatId, `🔄 *Standard | Cycle ${i + 1}/${STATE.numberOfCycles}* | Vol: \`${volMult.toFixed(2)}x\``, { parse_mode: "Markdown" });

        const activeWallets = usePool ? walletPool.getRandomSubset(walletCount) : [masterKeypair];
        const buyAmount = parseFloat((getRandomFloat(STATE.minBuyAmount, STATE.maxBuyAmount) * volMult).toFixed(4));
        
        bot.sendMessage(chatId, `🛒 Buying \`${buyAmount}\` SOL across ${activeWallets.length} wallets...`, { parse_mode: "Markdown" });

        await BatchSwapEngine.executeBatch(
            activeWallets,
            async (w) => await swap(SOL_ADDR, STATE.tokenAddress, w, connection, buyAmount, chatId, true),
            STATE.batchConcurrency,
            null,
            () => STATE.running
        );

        if (!STATE.running) break;
        await sleep(getPoissonDelay(STATE.intervalBetweenActions));

        bot.sendMessage(chatId, `📉 Selling positions...`, { parse_mode: "Markdown" });
        await BatchSwapEngine.executeBatch(
            activeWallets,
            async (w) => {
                const bal = await getTokenBalance(connection, w.publicKey, STATE.tokenAddress);
                if (bal > 0) return swap(STATE.tokenAddress, SOL_ADDR, w, connection, 'auto', chatId, true);
                return null;
            },
            STATE.batchConcurrency,
            null,
            () => STATE.running
        );

        if (i < STATE.numberOfCycles - 1 && STATE.running) {
            const wait = getPoissonDelay(STATE.intervalBetweenActions * 2);
            bot.sendMessage(chatId, `⏳ Next cycle in \`${Math.round(wait / 1000)}s\`...`, { parse_mode: "Markdown" });
            await sleep(wait);
        }
    }
}

async function executeMakerCycles(chatId, connection) {
    const usePool = STATE.useWalletPool && walletPool.size > 0;
    const walletCount = usePool ? Math.min(STATE.walletsPerCycle, walletPool.size) : STATE.makerWalletsToGenerate;
    bot.sendMessage(chatId, `📈 *Advanced Maker Mode*\n${usePool ? `Using ${walletCount} pool wallets` : `Generating ${walletCount} ephemeral wallets`}...`, { parse_mode: 'Markdown' });

    const childWallets = [];
    if (usePool) {
        const poolWallets = walletPool.getRandomSubset(walletCount);
        for (const kp of poolWallets) {
            const pKey = STATE.personalityMix[Math.floor(Math.random() * STATE.personalityMix.length)];
            childWallets.push({
                keypair: kp,
                personality: PERSONALITIES[pKey] || PERSONALITIES.RETAIL,
                pName: pKey,
                holdCyclesRemaining: 0,
                active: true
            });
        }
    } else {
        for (let i = 0; i < walletCount; i++) {
            const pKey = STATE.personalityMix[Math.floor(Math.random() * STATE.personalityMix.length)];
            childWallets.push({
                keypair: Keypair.generate(),
                personality: PERSONALITIES[pKey] || PERSONALITIES.RETAIL,
                pName: pKey,
                holdCyclesRemaining: 0,
                active: true
            });
        }
    }

    try {
        if (!usePool) {
            const fundAmount = parseFloat(getRandomFloat(STATE.minBuyAmount, STATE.maxBuyAmount).toFixed(4)) + 0.01;
            await fundWallets(connection, masterKeypair, childWallets.map(w => w.keypair), fundAmount, chatId);
        }

        bot.sendMessage(chatId, `✅ ${usePool ? 'Pool wallets selected' : 'Funding complete'}. Starting personality-driven trading...`);

        for (let cycle = 0; cycle < STATE.numberOfCycles && STATE.running; cycle++) {
            const volMult = getVolumeMultiplier();
            bot.sendMessage(chatId, `🔄 *Maker Cycle ${cycle + 1}/${STATE.numberOfCycles}* | ${childWallets.length} wallets | Vol: \`${volMult.toFixed(2)}x\``, { parse_mode: 'Markdown' });

            await BatchSwapEngine.executeBatch(
                childWallets,
                async (w) => {
                    if (!STATE.running) return;
                    const balance = await getTokenBalance(connection, w.keypair.publicKey, STATE.tokenAddress);
                    const roll = Math.random();
                    
                    if (balance > 0) {
                        if (w.holdCyclesRemaining <= 0 && roll < w.personality.sellProb) {
                            const sellAmt = Math.random() < 0.7 ? 'auto' : (balance * getRandomFloat(0.3, 0.7)).toFixed(6);
                            return swap(STATE.tokenAddress, SOL_ADDR, w.keypair, connection, sellAmt, chatId, true);
                        } else {
                            w.holdCyclesRemaining--;
                        }
                    } else {
                        if (roll < w.personality.buyProb) {
                            const baseAmt = getRandomFloat(STATE.minBuyAmount, STATE.maxBuyAmount);
                            const buyAmt = parseFloat((baseAmt * w.personality.sizeMult * volMult).toFixed(4));
                            w.holdCyclesRemaining = Math.floor(getRandomFloat(w.personality.minHold, w.personality.maxHold));
                            return swap(SOL_ADDR, STATE.tokenAddress, w.keypair, connection, buyAmt, chatId, true);
                        }
                    }
                },
                STATE.batchConcurrency,
                (p) => {
                    if (p.completed === p.total) {
                        bot.sendMessage(chatId, `✅ Cycle ${cycle + 1} complete: ${p.successes} trades, ${p.failures} failed`);
                    }
                },
                () => STATE.running
            );
            
            const waitTime = getPoissonDelay(STATE.intervalBetweenActions);
            bot.sendMessage(chatId, `⏳ Natural pause: \`${Math.round(waitTime / 1000)}s\`...`, { parse_mode: 'Markdown' });
            await sleep(waitTime);
        }

        if (!usePool) {
            bot.sendMessage(chatId, `🧹 Draining remaining SOL from ephemeral wallets...`);
            await drainWallets(connection, childWallets.map(w => w.keypair), masterKeypair.publicKey, chatId);
        }
        bot.sendMessage(chatId, `✅ Maker session complete (${childWallets.length} wallets used).`);

    } catch (err) {
        logger.error(`Maker Loop Error: ${err.message}`);
        bot.sendMessage(chatId, `⚠️ Maker Error: ${err.message}`);
    }
}

async function executeWebOfActivity(chatId, connection) {
    const usePool = STATE.useWalletPool && walletPool.size > 0;
    const walletCount = usePool ? Math.min(STATE.walletsPerCycle, walletPool.size) : 5;
    bot.sendMessage(chatId, `🕸️ *Strategy: Web of Activity*\n${usePool ? `Using ${walletCount} pool wallets` : `Generating ${walletCount} ephemeral wallets`}...`, { parse_mode: 'Markdown' });
    
    const targets = usePool ? walletPool.getRandomSubset(walletCount) : Array.from({ length: walletCount }, () => Keypair.generate());
    
    if (!usePool) {
        await fundWallets(connection, masterKeypair, targets, 0.05, chatId);
    }
    
    for (let i = 0; i < STATE.numberOfCycles && STATE.running; i++) {
        bot.sendMessage(chatId, `🕸️ Web Cycle ${i+1}/${STATE.numberOfCycles} | ${walletCount} wallets`);
        const activeCount = Math.min(Math.max(2, Math.floor(walletCount * 0.3)), walletCount);
        const activeWallets = targets.sort(() => Math.random() - 0.5).slice(0, activeCount);
        
        await BatchSwapEngine.executeBatch(
            activeWallets,
            async (w) => {
                const balance = await getTokenBalance(connection, w.publicKey, STATE.tokenAddress);
                if (balance > 0 && Math.random() < 0.6) {
                    return swap(STATE.tokenAddress, SOL_ADDR, w, connection, 'auto', chatId, true);
                } else {
                    const amt = parseFloat((getRandomFloat(STATE.minBuyAmount, STATE.maxBuyAmount) * getVolumeMultiplier()).toFixed(4));
                    return swap(SOL_ADDR, STATE.tokenAddress, w, connection, amt, chatId, true);
                }
            },
            STATE.batchConcurrency,
            null,
            () => STATE.running
        );
        await sleep(getPoissonDelay(STATE.intervalBetweenActions));
    }
    
    if (!usePool) {
        await drainWallets(connection, targets, masterKeypair.publicKey, chatId);
    }
    bot.sendMessage(chatId, `✅ Web of Activity complete (${walletCount} wallets).`);
}

async function executeSpamMode(chatId, connection) {
    const usePool = STATE.useWalletPool && walletPool.size > 0;
    const walletCount = usePool ? Math.min(STATE.walletsPerCycle, walletPool.size) : 5;
    bot.sendMessage(chatId, `🔥 *Micro-Spam Mode*\nSpamming ${STATE.numberOfCycles} cycles of micro-buys (\`${STATE.spamMicroBuyAmount}\` SOL) across ${walletCount} wallets...`, { parse_mode: 'Markdown' });

    const activeWallets = usePool ? walletPool.getRandomSubset(walletCount) : [masterKeypair];

    let globalSuccessCount = 0;
    for (let i = 0; i < STATE.numberOfCycles && STATE.running; i++) {
        bot.sendMessage(chatId, `⚡ Spam Cycle ${i + 1}/${STATE.numberOfCycles}...`);
        const { successes } = await BatchSwapEngine.executeBatch(
            activeWallets,
            async (w) => await swap(SOL_ADDR, STATE.tokenAddress, w, connection, STATE.spamMicroBuyAmount, chatId, true),
            STATE.batchConcurrency,
            null,
            () => STATE.running
        );
        globalSuccessCount += successes;
        await sleep(getJitteredInterval(1500, STATE.jitterPercentage));
    }
    bot.sendMessage(chatId, `📊 Spam complete: ${globalSuccessCount} transactions confirmed.`);

    bot.sendMessage(chatId, `📉 Dumping accumulated spam tokens...`);
    await BatchSwapEngine.executeBatch(
        activeWallets,
        async (w) => {
            const bal = await getTokenBalance(connection, w.publicKey, STATE.tokenAddress);
            if (bal > 0) return swap(STATE.tokenAddress, SOL_ADDR, w, connection, 'auto', chatId, true);
            return null;
        },
        STATE.batchConcurrency,
        null,
        () => STATE.running
    );
}

async function executeChartPattern(chatId, connection) {
    const pattern = STATE.chartPattern;
    const n = STATE.numberOfCycles;
    const usePool = STATE.useWalletPool && walletPool.size > 0;
    const walletCount = usePool ? Math.min(STATE.walletsPerCycle, walletPool.size) : 5;
    bot.sendMessage(chatId, `📐 *Chart Pattern: ${pattern}*\nRunning ${n} cycles across ${usePool ? `${walletCount} pool wallets` : `master/ephemeral wallets`}...`, { parse_mode: 'Markdown' });

    for (let i = 0; i < n && STATE.running; i++) {
        let buyMult, sellFrac;
        const progress = i / Math.max(n - 1, 1);
        if (pattern === 'ASCENDING') {
            buyMult = 0.5 + progress;
            sellFrac = 0.3 + (1 - progress) * 0.4;
        } else if (pattern === 'DESCENDING') {
            buyMult = 1.5 - progress;
            sellFrac = 0.3 + progress * 0.6;
        } else if (pattern === 'SIDEWAYS') {
            buyMult = 0.9 + Math.sin(progress * Math.PI * 4) * 0.2;
            sellFrac = 0.85;
        } else if (pattern === 'CUP_HANDLE') {
            const cup = Math.sin(progress * Math.PI);
            const handle = progress > 0.8 ? 0.3 * Math.sin((progress - 0.8) * Math.PI / 0.2) : 0;
            buyMult = 0.4 + cup * 0.8 - handle * 0.3;
            sellFrac = 0.5 + (1 - cup) * 0.4;
        } else {
            buyMult = progress < 0.7 ? 0.6 : 1.8;
            sellFrac = progress < 0.7 ? 0.9 : 0.2;
        }

        const activeWallets = usePool ? walletPool.getRandomSubset(walletCount) : [masterKeypair];
        const buyAmount = parseFloat((STATE.minBuyAmount + (STATE.maxBuyAmount - STATE.minBuyAmount) * buyMult * 0.7).toFixed(4));
        bot.sendMessage(chatId, `📐 Cycle ${i + 1}/${n} [${pattern}] | Buy: \`${buyAmount}\` SOL | SellFrac: \`${(sellFrac * 100).toFixed(0)}%\``, { parse_mode: 'Markdown' });

        await BatchSwapEngine.executeBatch(
            activeWallets,
            async (w) => await swap(SOL_ADDR, STATE.tokenAddress, w, connection, buyAmount, chatId, true),
            STATE.batchConcurrency,
            null,
            () => STATE.running
        );
        await sleep(getJitteredInterval(STATE.intervalBetweenActions, STATE.jitterPercentage));

        await BatchSwapEngine.executeBatch(
            activeWallets,
            async (w) => {
                const bal = await getTokenBalance(connection, w.publicKey, STATE.tokenAddress);
                if (bal > 0) {
                    const sellAmt = parseFloat((bal * sellFrac).toFixed(6));
                    return swap(STATE.tokenAddress, SOL_ADDR, w, connection, sellAmt > 0 ? sellAmt : 'auto', chatId, true);
                }
            },
            STATE.batchConcurrency,
            null,
            () => STATE.running
        );

        if (i < n - 1 && STATE.running)
            await sleep(getJitteredInterval(STATE.intervalBetweenActions, STATE.jitterPercentage));
    }
    bot.sendMessage(chatId, `✅ Chart pattern *${pattern}* complete.`, { parse_mode: 'Markdown' });
}

async function executeHolderGrowth(chatId, connection) {
    const usePool = STATE.useWalletPool && walletPool.size > 0;
    const count = usePool ? Math.min(STATE.holderWallets, walletPool.size) : STATE.holderWallets;
    const amt = STATE.holderBuyAmount;
    bot.sendMessage(chatId, `👥 *Holder Growth Simulation*\n${usePool ? `Using ${count} pool wallets` : `Creating ${count} new wallets`} @ \`${amt}\` SOL each...`, { parse_mode: 'Markdown' });

    const wallets = usePool ? walletPool.getRandomSubset(count) : Array.from({ length: count }, () => Keypair.generate());
    const fundNeeded = amt + 0.003;

    await BatchSwapEngine.executeBatch(
        wallets,
        async (w, i) => {
            if (!usePool) {
                await fundWallets(connection, masterKeypair, [w], fundNeeded, chatId);
                await sleep(1200);
            }
            const txid = await swap(SOL_ADDR, STATE.tokenAddress, w, connection, amt, chatId, true);
            if (txid && (i + 1) % Math.max(1, Math.floor(count / 10)) === 0) {
                bot.sendMessage(chatId, `✅ Holder ${i + 1}/${count} now holds tokens.`);
            }
            return txid;
        },
        STATE.batchConcurrency,
        (p) => {
            if (p.completed === p.total) {
                bot.sendMessage(chatId, `🏁 Holder growth complete. *+${p.successes} holders* created (${p.failures} failed).`, { parse_mode: 'Markdown' });
            }
        },
        () => STATE.running
    );

    if (!usePool) {
        await drainWallets(connection, wallets, masterKeypair.publicKey, chatId);
    }
}

async function executeWhaleSimulation(chatId, connection) {
    const usePool = STATE.useWalletPool && walletPool.size > 0;
    const whaleCount = usePool ? Math.min(5, walletPool.size) : 1;
    const buyAmt = STATE.whaleBuyAmount;
    const dumpPct = STATE.whaleSellPercent / 100;
    const volMult = getVolumeMultiplier();
    bot.sendMessage(chatId, `🐋 *Whale Simulation*\nUsing ${whaleCount} coordinated wallets to buy \`${buyAmt}\` SOL (Vol: ${volMult.toFixed(1)}x), then dump \`${STATE.whaleSellPercent}%\`...`, { parse_mode: 'Markdown' });

    const activeWhales = usePool ? walletPool.getRandomSubset(whaleCount) : [masterKeypair];

    for (let i = 0; i < STATE.numberOfCycles && STATE.running; i++) {
        const jitteredAmt = parseFloat((buyAmt * (0.85 + Math.random() * 0.3) * volMult).toFixed(4));
        bot.sendMessage(chatId, `🐋 Whale accumulation ${i + 1}/${STATE.numberOfCycles} across ${whaleCount} wallets: \`${jitteredAmt}\` SOL`, { parse_mode: 'Markdown' });
        await BatchSwapEngine.executeBatch(
            activeWhales,
            async (w) => await swap(SOL_ADDR, STATE.tokenAddress, w, connection, jitteredAmt, chatId, true),
            STATE.batchConcurrency,
            null,
            () => STATE.running
        );
        await sleep(getPoissonDelay(STATE.intervalBetweenActions * 2));
    }

    if (!STATE.running) return;

    bot.sendMessage(chatId, `🔴 Whale Cluster dumping ${STATE.whaleSellPercent}% of holdings...`, { parse_mode: 'Markdown' });
    await BatchSwapEngine.executeBatch(
        activeWhales,
        async (w) => {
            const bal = await getTokenBalance(connection, w.publicKey, STATE.tokenAddress);
            if (bal > 0) {
                const dumpAmt = parseFloat((bal * dumpPct).toFixed(6));
                return swap(STATE.tokenAddress, SOL_ADDR, w, connection, dumpAmt, chatId, true);
            }
        },
        STATE.batchConcurrency,
        null,
        () => STATE.running
    );
    bot.sendMessage(chatId, `🐋 Whale simulation complete.`);
}

async function executeVolumeBoost(chatId, connection) {
    const usePool = STATE.useWalletPool && walletPool.size > 0;
    const walletCount = usePool ? Math.min(STATE.walletsPerCycle, walletPool.size) : STATE.volumeBoostMultiplier;
    const cycles = STATE.volumeBoostCycles;
    bot.sendMessage(chatId, `📊 *Volume Boost Mode*\n${usePool ? `Using ${walletCount} pool wallets` : `Spawning ${walletCount} ephemeral wallets`} × ${cycles} cycles...`, { parse_mode: 'Markdown' });

    const wallets = usePool ? walletPool.getRandomSubset(walletCount) : Array.from({ length: walletCount }, () => Keypair.generate());
    
    if (!usePool) {
        const fundAmt = STATE.volumeBoostMaxAmount + 0.01;
        for (let i = 0; i < wallets.length && STATE.running; i++) {
            try {
                await sendSOL(connection, masterKeypair, wallets[i].publicKey, fundAmt);
                if ((i + 1) % 10 === 0 || i === wallets.length - 1) bot.sendMessage(chatId, `💸 Funded ${i + 1}/${walletCount}`);
            } catch (e) {
                bot.sendMessage(chatId, `⚠️ Fund failed ${i + 1}: ${e.message}`);
            }
            await sleep(500);
        }
    }

    for (let cycle = 0; cycle < cycles && STATE.running; cycle++) {
        bot.sendMessage(chatId, `🔄 Volume Cycle ${cycle + 1}/${cycles} | ${walletCount} wallets - Batch buys...`);
        await BatchSwapEngine.executeBatch(
            wallets,
            (w) => {
                const amt = parseFloat(getRandomFloat(STATE.volumeBoostMinAmount, STATE.volumeBoostMaxAmount).toFixed(4));
                return swap(SOL_ADDR, STATE.tokenAddress, w, connection, amt, chatId, true);
            },
            STATE.batchConcurrency,
            null,
            () => STATE.running
        );
        await sleep(getJitteredInterval(3000, STATE.jitterPercentage));

        bot.sendMessage(chatId, `📉 Batch sells (${walletCount} wallets)...`);
        await BatchSwapEngine.executeBatch(
            wallets,
            async (w) => {
                const bal = await getTokenBalance(connection, w.publicKey, STATE.tokenAddress);
                if (bal > 0) return swap(STATE.tokenAddress, SOL_ADDR, w, connection, 'auto', chatId, true);
                return null;
            },
            STATE.batchConcurrency,
            (p) => {
                if (p.completed === p.total) {
                    bot.sendMessage(chatId, `✅ Cycle ${cycle + 1}: ${p.successes} sells complete`);
                }
            },
            () => STATE.running
        );

        if (cycle < cycles - 1 && STATE.running)
            await sleep(getJitteredInterval(STATE.intervalBetweenActions, STATE.jitterPercentage));
    }

    if (!usePool) {
        bot.sendMessage(chatId, `🧹 Draining volume wallets...`);
        await drainWallets(connection, wallets, masterKeypair.publicKey, chatId);
    }
    bot.sendMessage(chatId, `✅ Volume Boost complete: ${walletCount} wallets × ${cycles} cycles.`);
}

async function executeTrendingStrategy(chatId, connection) {
    const mode = STATE.trendingMode;
    const intensity = STATE.trendingIntensity;
    const usePool = STATE.useWalletPool && walletPool.size > 0;
    const walletCount = usePool ? Math.min(STATE.walletsPerCycle, walletPool.size) : 1;
    bot.sendMessage(chatId, `🔥 *Trending: ${mode}* (Intensity: ${intensity}/10)\nUsing ${usePool ? `${walletCount} pool wallets` : `master wallet`}`, { parse_mode: 'Markdown' });

    const activeWallets = usePool ? walletPool.getRandomSubset(walletCount) : [masterKeypair];

    if (mode === 'VIRAL_PUMP') {
        const cycles = Math.floor(5 + intensity * 2);
        for (let i = 0; i < cycles && STATE.running; i++) {
            const buyMult = Math.pow(1.3, i / cycles);
            const buyAmt = parseFloat((STATE.minBuyAmount * buyMult * intensity * 0.3).toFixed(4));
            bot.sendMessage(chatId, `🚀 Viral buy ${i + 1}/${cycles}: \`${buyAmt}\` SOL across wallets...`, { parse_mode: 'Markdown' });
            await BatchSwapEngine.executeBatch(
                activeWallets.slice(0, Math.max(1, Math.floor(activeWallets.length * (i/cycles)))),
                async (w) => await swap(SOL_ADDR, STATE.tokenAddress, w, connection, buyAmt, chatId, true),
                STATE.batchConcurrency, null, () => STATE.running
            );
            if (i % 2 === 0 && STATE.running) {
                await BatchSwapEngine.executeBatch(
                    activeWallets,
                    async (w) => {
                        const bal = await getTokenBalance(connection, w.publicKey, STATE.tokenAddress);
                        if (bal > 0) return swap(STATE.tokenAddress, SOL_ADDR, w, connection, parseFloat((bal * 0.1).toFixed(6)), chatId, true);
                        return null;
                    },
                    STATE.batchConcurrency, null, () => STATE.running
                );
            }
            await sleep(getJitteredInterval(2000, STATE.jitterPercentage));
        }
    } else if (mode === 'ORGANIC_GROWTH') {
        const cycles = Math.floor(10 + intensity);
        for (let i = 0; i < cycles && STATE.running; i++) {
            const buyAmt = parseFloat(getRandomFloat(STATE.minBuyAmount, STATE.maxBuyAmount).toFixed(4));
            const randomWallets = activeWallets.sort(() => Math.random() - 0.5).slice(0, Math.max(1, Math.floor(activeWallets.length * 0.2)));
            bot.sendMessage(chatId, `🌱 Organic buy ${i + 1}/${cycles}: \`${buyAmt}\` SOL`, { parse_mode: 'Markdown' });
            await BatchSwapEngine.executeBatch(randomWallets, async (w) => await swap(SOL_ADDR, STATE.tokenAddress, w, connection, buyAmt, chatId, true), STATE.batchConcurrency, null, () => STATE.running);
            const pause = getJitteredInterval(5000 + intensity * 2000, 50);
            await sleep(pause);
            if (Math.random() < 0.2 && STATE.running) {
                await BatchSwapEngine.executeBatch(randomWallets, async (w) => {
                    const bal = await getTokenBalance(connection, w.publicKey, STATE.tokenAddress);
                    if (bal > 0) return swap(STATE.tokenAddress, SOL_ADDR, w, connection, parseFloat((bal * 0.15).toFixed(6)), chatId, true);
                    return null;
                }, STATE.batchConcurrency, null, () => STATE.running);
            }
        }
    } else if (mode === 'FOMO_WAVE') {
        const waves = Math.floor(2 + intensity * 0.5);
        for (let wave = 0; wave < waves && STATE.running; wave++) {
            bot.sendMessage(chatId, `🌊 FOMO Wave ${wave + 1}/${waves} - Rapid buys!`, { parse_mode: 'Markdown' });
            const buysPerWave = Math.floor(3 + intensity);
            for (let i = 0; i < buysPerWave && STATE.running; i++) {
                const buyAmt = parseFloat(getRandomFloat(STATE.minBuyAmount * 1.5, STATE.maxBuyAmount * 2).toFixed(4));
                const surgeWallets = activeWallets.sort(() => Math.random() - 0.5).slice(0, Math.max(1, Math.floor(activeWallets.length * 0.4)));
                await BatchSwapEngine.executeBatch(surgeWallets, async (w) => await swap(SOL_ADDR, STATE.tokenAddress, w, connection, buyAmt, chatId, true), STATE.batchConcurrency, null, () => STATE.running);
                await sleep(1500);
            }
            if (wave < waves - 1 && STATE.running) {
                const cooldown = getJitteredInterval(15000 + intensity * 3000, 30);
                bot.sendMessage(chatId, `⏸️ Wave cooldown: ${Math.round(cooldown / 1000)}s...`);
                await sleep(cooldown);
            }
        }
    } else if (mode === 'LIQUIDITY_LADDER') {
        const steps = Math.floor(5 + intensity);
        for (let i = 0; i < steps && STATE.running; i++) {
            const stepMult = 1 + (i / steps) * intensity * 0.4;
            const buyAmt = parseFloat((STATE.minBuyAmount * stepMult).toFixed(4));
            const ladders = activeWallets.sort(() => Math.random() - 0.5).slice(0, Math.max(1, Math.floor(activeWallets.length * 0.3)));
            bot.sendMessage(chatId, `🪜 Ladder step ${i + 1}/${steps}: \`${buyAmt}\` SOL`, { parse_mode: 'Markdown' });
            await BatchSwapEngine.executeBatch(ladders, async (w) => await swap(SOL_ADDR, STATE.tokenAddress, w, connection, buyAmt, chatId, true), STATE.batchConcurrency, null, () => STATE.running);
            await sleep(getJitteredInterval(STATE.intervalBetweenActions, STATE.jitterPercentage));
        }
    } else if (mode === 'WASH_TRADING') {
        const pairs = Math.floor(10 + intensity * 3);
        bot.sendMessage(chatId, `🔄 Wash Trading: ${pairs} pairs using distinct wallets...`);
        for (let i = 0; i < pairs && STATE.running; i++) {
            const amt = parseFloat(getRandomFloat(STATE.minBuyAmount * 0.5, STATE.maxBuyAmount * 0.7).toFixed(4));
            const washSubset = activeWallets.sort(() => Math.random() - 0.5).slice(0, Math.max(2, Math.floor(activeWallets.length * 0.2)));
            const half = Math.floor(washSubset.length / 2);
            const buyers = washSubset.slice(0, half) || [masterKeypair];
            const sellers = washSubset.slice(half) || [masterKeypair];
            await BatchSwapEngine.executeBatch(buyers, async (w) => await swap(SOL_ADDR, STATE.tokenAddress, w, connection, amt, chatId, true), STATE.batchConcurrency, null, () => STATE.running);
            await sleep(getJitteredInterval(2000, 10));
            await BatchSwapEngine.executeBatch(sellers, async (w) => {
                const bal = await getTokenBalance(connection, w.publicKey, STATE.tokenAddress);
                if (bal > 0) return swap(STATE.tokenAddress, SOL_ADDR, w, connection, 'auto', chatId, true);
                return null;
            }, STATE.batchConcurrency, null, () => STATE.running);
            if ((i + 1) % 5 === 0) bot.sendMessage(chatId, `🔄 Wash pairs: ${i + 1}/${pairs}`);
            await sleep(getJitteredInterval(3000, STATE.jitterPercentage));
        }
    }
    bot.sendMessage(chatId, `🏁 Trending strategy *${mode}* complete!`, { parse_mode: 'Markdown' });
}

async function executePumpDump(chatId, connection) {
    const usePool = STATE.useWalletPool && walletPool.size > 0;
    const walletCount = usePool ? Math.min(STATE.walletsPerCycle, walletPool.size) : 5;
    bot.sendMessage(chatId, `🚀 *PUMP & DUMP MODE*\nAccumulating tokens across ${STATE.numberOfCycles} cycles using ${usePool ? `${walletCount} pool wallets` : `master wallet`}...`, { parse_mode: 'Markdown' });

    const activeWallets = usePool ? walletPool.getRandomSubset(walletCount) : [masterKeypair];

    for (let i = 0; i < STATE.numberOfCycles && STATE.running; i++) {
        const buyAmount = parseFloat(getRandomFloat(STATE.minBuyAmount, STATE.maxBuyAmount).toFixed(4));
        bot.sendMessage(chatId, `🛒 Buy ${i + 1}/${STATE.numberOfCycles}: \`${buyAmount}\` SOL across wallets...`, { parse_mode: 'Markdown' });
        await BatchSwapEngine.executeBatch(
            activeWallets,
            async (w) => await swap(SOL_ADDR, STATE.tokenAddress, w, connection, buyAmount, chatId, true),
            STATE.batchConcurrency,
            null,
            () => STATE.running
        );
        await sleep(5000);
    }

    if (!STATE.running) return;

    bot.sendMessage(chatId, `🔴 *DUMPING ALL TOKENS NOW!*`, { parse_mode: 'Markdown' });
    await BatchSwapEngine.executeBatch(
        activeWallets,
        async (w) => {
            const bal = await getTokenBalance(connection, w.publicKey, STATE.tokenAddress);
            if (bal > 0) return swap(STATE.tokenAddress, SOL_ADDR, w, connection, 'auto', chatId, true);
            return null;
        },
        STATE.batchConcurrency,
        null,
        () => STATE.running
    );
}

async function executeJitoMevWash(chatId, connection) {
    if (!STATE.useJito) {
        bot.sendMessage(chatId, `❌ Jito Protect must be ON to use MEV Wash!`, { parse_mode: 'Markdown' });
        return;
    }
    const cycles = STATE.numberOfCycles;
    const usePool = STATE.useWalletPool && walletPool.size > 0;
    bot.sendMessage(chatId, `🌪️ *JITO MEV WASH STRATEGY*\nExecuting bundled Buy & Sell simultaneously for ${cycles} cycles using ${usePool ? `pool wallets` : `master wallet`}...`, { parse_mode: 'Markdown' });

    for (let i = 0; i < cycles && STATE.running; i++) {
        const amt = parseFloat(getRandomFloat(STATE.minBuyAmount, STATE.maxBuyAmount).toFixed(4));
        const activeWallet = usePool ? walletPool.getRandomSubset(1)[0] : masterKeypair;
        bot.sendMessage(chatId, `🌪️ Wash Bundle ${i + 1}/${cycles} [${activeWallet.publicKey.toBase58().substring(0,4)}...]: \`${amt}\` SOL`, { parse_mode: 'Markdown' });
        try {
            const buyId = await swap(SOL_ADDR, STATE.tokenAddress, activeWallet, connection, amt, chatId, true);
            if (buyId) {
                await sleep(1000);
                await swap(STATE.tokenAddress, SOL_ADDR, activeWallet, connection, 'auto', chatId, true);
            }
        } catch (err) {
            bot.sendMessage(chatId, `⚠️ Wash Error: ${err.message}`);
        }
        await sleep(getJitteredInterval(STATE.intervalBetweenActions, STATE.jitterPercentage));
    }
    bot.sendMessage(chatId, `✅ JITO MEV Wash Complete.`);
}

async function executeKolAlphaCall(chatId, connection) {
    const usePool = STATE.useWalletPool && walletPool.size > 0;
    const swarmSize = Math.min(STATE.kolRetailSwarmSize, usePool ? walletPool.size : 20);
    bot.sendMessage(chatId, `📱 *KOL ALPHA CALL SIMULATION*\nDeploying 1 Whale buy + ${swarmSize} Retail follower buys...`, { parse_mode: 'Markdown' });

    const whaleAmt = parseFloat((STATE.maxBuyAmount * 3).toFixed(4));
    bot.sendMessage(chatId, `🐋 KOL Whale calling with massive buy of \`${whaleAmt}\` SOL...`);
    await swap(SOL_ADDR, STATE.tokenAddress, masterKeypair, connection, whaleAmt, chatId, true);
    await sleep(2000);

    const swarmWallets = usePool ? walletPool.getRandomSubset(swarmSize) : Array.from({ length: swarmSize }, () => Keypair.generate());
    
    if (!usePool) {
        bot.sendMessage(chatId, `🐟 Retail swarm entering: Funding ${swarmWallets.length} wallets...`);
        await fundWallets(connection, masterKeypair, swarmWallets, STATE.minBuyAmount + 0.005, chatId);
    } else {
        bot.sendMessage(chatId, `🐟 Retail swarm entering: ${swarmWallets.length} pool wallets ready...`);
    }

    bot.sendMessage(chatId, `🚀 Retail FOMO activated! (${swarmWallets.length} wallets)`);
    await BatchSwapEngine.executeBatch(
        swarmWallets,
        (w) => {
            const amt = parseFloat(getRandomFloat(STATE.minBuyAmount * 0.1, STATE.minBuyAmount * 0.8).toFixed(4));
            return swap(SOL_ADDR, STATE.tokenAddress, w, connection, amt, chatId, true);
        },
        STATE.batchConcurrency,
        (p) => {
            if (p.completed === p.total) {
                bot.sendMessage(chatId, `✅ KOL Alpha Call finished: ${p.successes} retail buys executed.`);
            }
        },
        () => STATE.running
    );

    if (!usePool) {
        await drainWallets(connection, swarmWallets, masterKeypair.publicKey, chatId);
    }
}

async function executeBullTrap(chatId, connection) {
    bot.sendMessage(chatId, `🐻 *BULL TRAP MANIPULATION*\nFaking breakout then dumping at max slippage!`, { parse_mode: 'Markdown' });
    const steps = 5;
    for (let i = 0; i < steps && STATE.running; i++) {
        const amt = parseFloat((STATE.minBuyAmount * (1 + i * 0.5)).toFixed(4));
        bot.sendMessage(chatId, `📈 Bait Buy ${i+1}/${steps}: \`${amt}\` SOL`);
        await swap(SOL_ADDR, STATE.tokenAddress, masterKeypair, connection, amt, chatId, true);
        await sleep(getJitteredInterval(1500, 10));
    }
    bot.sendMessage(chatId, `⏳ Waiting 5s for MEV/Retail bots to bite...`);
    await sleep(getJitteredInterval(5000, 5));
    const bal = await getTokenBalance(connection, masterKeypair.publicKey, STATE.tokenAddress);
    if (bal > 0) {
        const oldSlip = STATE.slippage;
        STATE.slippage = STATE.bullTrapSlippage || 20;
        bot.sendMessage(chatId, `🔴 RUGGING \`${bal}\` TOKENS AT ${STATE.slippage}% SLIPPAGE!`);
        await swap(STATE.tokenAddress, SOL_ADDR, masterKeypair, connection, 'auto', chatId, false);
        STATE.slippage = oldSlip;
    }
    bot.sendMessage(chatId, `✅ Bull Trap Complete.`);
}

async function executeSocialProofAirdrop(chatId, connection) {
    const usePool = STATE.useWalletPool && walletPool.size > 0;
    const wCount = usePool ? Math.min(STATE.airdropWalletCount, walletPool.size) : Math.min(STATE.airdropWalletCount, 30);
    bot.sendMessage(chatId, `🕸️ *SOCIAL PROOF AIRDROP (HOLDER SWARM)*\n${usePool ? `Using ${wCount} pool wallets` : `Creating ${wCount} ephemeral wallets`}...`, { parse_mode: 'Markdown' });

    const swarmWallets = usePool ? walletPool.getRandomSubset(wCount) : Array.from({ length: wCount }, () => Keypair.generate());
    
    if (!usePool) {
        const fundAmt = 0.015;
        bot.sendMessage(chatId, `💸 Funding ${wCount} wallets with \`${fundAmt}\` SOL each...`);
        await BatchSwapEngine.executeBatch(
            swarmWallets,
            async (w, i) => {
                await fundWallets(connection, masterKeypair, [w], fundAmt, chatId);
                if ((i + 1) % Math.max(1, Math.floor(wCount / 5)) === 0) bot.sendMessage(chatId, `💸 Funded ${i + 1}/${wCount}`);
            },
            STATE.batchConcurrency,
            null,
            () => STATE.running
        );
    }

    bot.sendMessage(chatId, `🚀 Executing swarm buys (${swarmWallets.length} wallets)...`);
    await BatchSwapEngine.executeBatch(
        swarmWallets,
        async (w, index) => {
            const amt = parseFloat(getRandomFloat(0.001, 0.005).toFixed(4));
            const txid = await swap(SOL_ADDR, STATE.tokenAddress, w, connection, amt, chatId, true);
            return txid;
        },
        STATE.batchConcurrency,
        (p) => {
            if (p.completed === p.total) {
                bot.sendMessage(chatId, `✅ Social Proof Airdrop finished. *+${p.successes}* unique holders created (${p.failures} failed).`, { parse_mode: 'Markdown' });
            }
        },
        () => STATE.running
    );

    if (!usePool) {
        await drainWallets(connection, swarmWallets, masterKeypair.publicKey, chatId);
    }
}

// ---------- Master Engine ----------
async function startEngine(chatId) {
    if (!masterKeypair) {
        bot.sendMessage(chatId, `❌ No wallet loaded! Add PRIVKEY to .env and restart.`);
        return;
    }
    if (!STATE.tokenAddress) {
        bot.sendMessage(chatId, `❌ Set the Token CA first via ⚙️ Advanced Config.`);
        return;
    }

    try {
        await withRpcFallback(async (connection) => {
            STATE.running = true;
            const balance = await connection.getBalance(masterKeypair.publicKey) / LAMPORTS_PER_SOL;
            bot.sendMessage(chatId, `💰 Master wallet SOL balance: \`${balance.toFixed(4)}\`\n🚀 Launching *${STATE.strategy}* strategy...\n📈 Jito: \`${STATE.useJito ? 'ON' : 'OFF'}\` | Vol Curve: \`${STATE.useVolumeCurve ? 'ON' : 'OFF'}\` | Web Fund: \`${STATE.useWebFunding ? 'ON' : 'OFF'}\` | Stealth: \`${STATE.fundingStealthLevel === 2 ? 'Multi-hop' : 'Direct'}\``, { parse_mode: 'Markdown' });

            if (balance < STATE.minBuyAmount + STATE.priorityFee) {
                bot.sendMessage(chatId, `❌ Insufficient SOL balance to operate. Need at least \`${(STATE.minBuyAmount + STATE.priorityFee).toFixed(4)}\` SOL.`, { parse_mode: 'Markdown' });
                STATE.running = false;
                return;
            }

            if (STATE.strategy === "STANDARD") await executeStandardCycles(chatId, connection);
            else if (STATE.strategy === "MAKER") await executeMakerCycles(chatId, connection);
            else if (STATE.strategy === "WEB_OF_ACTIVITY") await executeWebOfActivity(chatId, connection);
            else if (STATE.strategy === "SPAM") await executeSpamMode(chatId, connection);
            else if (STATE.strategy === "PUMP_DUMP") await executePumpDump(chatId, connection);
            else if (STATE.strategy === "CHART_PATTERN") await executeChartPattern(chatId, connection);
            else if (STATE.strategy === "HOLDER_GROWTH") await executeHolderGrowth(chatId, connection);
            else if (STATE.strategy === "WHALE") await executeWhaleSimulation(chatId, connection);
            else if (STATE.strategy === "VOLUME_BOOST") await executeVolumeBoost(chatId, connection);
            else if (STATE.strategy === "TRENDING") await executeTrendingStrategy(chatId, connection);
            else if (STATE.strategy === "JITO_MEV_WASH") await executeJitoMevWash(chatId, connection);
            else if (STATE.strategy === "KOL_ALPHA_CALL") await executeKolAlphaCall(chatId, connection);
            else if (STATE.strategy === "BULL_TRAP") await executeBullTrap(chatId, connection);
            else if (STATE.strategy === "SOCIAL_PROOF_AIRDROP") await executeSocialProofAirdrop(chatId, connection);

            if (STATE.running) bot.sendMessage(chatId, `🏁 *Strategy Complete!*`, { parse_mode: "Markdown" });
            STATE.running = false;
        });
    } catch (e) {
        logger.error(`Engine Error: ${e.message}`);
        bot.sendMessage(chatId, `⚠️ Engine Error: ${e.message}`);
        STATE.running = false;
    }
}

// ---------- Telegram UI Menus ----------
function showMainMenu(chatId) {
    const statusIcon = STATE.running ? '🟢' : '🔴';
    const statusText = STATE.running ? 'RUNNING' : 'IDLE';
    bot.sendMessage(chatId,
        `╔═══════════════════════╗\n║  🤖 *VOLUME BOT v2.0*  ║\n╚═══════════════════════╝\n\n⚡ *Status:* ${statusIcon} ${statusText}\n🎯 *Strategy:* \`${STATE.strategy}\`\n💼 *Wallet Pool:* \`${walletPool.size.toLocaleString()}\` wallets\n🪙 *Token:* ${STATE.tokenAddress ? '✅ Set' : '❌ Not Set'}\n━━━━━━━━━━━━━━━━━━━━━━━`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
            [{ text: (STATE.running ? '🛑 EMERGENCY STOP' : '🚀 LAUNCH ENGINE'), callback_data: (STATE.running ? 'stop_cycles' : 'start_cycles') }],
            [{ text: '📈 Strategies', callback_data: 'strategies' }, { text: '⚙️ Settings', callback_data: 'settings' }],
            [{ text: '💼 Wallet Pool', callback_data: 'wallet_pool' }, { text: '📊 Dashboard', callback_data: 'status' }],
            [{ text: '📜 My Wallet', callback_data: 'show_wallet' }, { text: '❓ Help', callback_data: 'help' }]
        ] } }
    );
}

function showStrategyMenu(chatId) {
    const s = STATE.strategy;
    bot.sendMessage(chatId,
        `📈 *STRATEGY SELECTION*\n━━━━━━━━━━━━━━━━━━━━━━━\nCurrent: *${s}*\n\nChoose your trading strategy:`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
            [{ text: (s === 'STANDARD' ? '✅ ' : '') + '🌐 Standard', callback_data: 'strat_standard' }, { text: (s === 'MAKER' ? '✅ ' : '') + '📈 Maker', callback_data: 'strat_maker' }],
            [{ text: (s === 'WEB_OF_ACTIVITY' ? '✅ ' : '') + '🕸️ Web Activity', callback_data: 'strat_web' }, { text: (s === 'SPAM' ? '✅ ' : '') + '⚡ Spam', callback_data: 'strat_spam' }],
            [{ text: (s === 'PUMP_DUMP' ? '✅ ' : '') + '🚀 Pump & Dump', callback_data: 'strat_pumpdump' }, { text: (s === 'CHART_PATTERN' ? '✅ ' : '') + '📐 Chart Pattern', callback_data: 'strat_chart' }],
            [{ text: (s === 'HOLDER_GROWTH' ? '✅ ' : '') + '👥 Holder Growth', callback_data: 'strat_holder' }, { text: (s === 'WHALE' ? '✅ ' : '') + '🐋 Whale', callback_data: 'strat_whale' }],
            [{ text: (s === 'VOLUME_BOOST' ? '✅ ' : '') + '📊 Volume Boost', callback_data: 'strat_volume' }, { text: (s === 'TRENDING' ? '✅ ' : '') + '🔥 Trending', callback_data: 'strat_trending' }],
            [{ text: (s === 'JITO_MEV_WASH' ? '✅ ' : '') + '🌪️ MEV Wash', callback_data: 'strat_mev_wash' }, { text: (s === 'KOL_ALPHA_CALL' ? '✅ ' : '') + '📱 KOL Call', callback_data: 'strat_kol' }],
            [{ text: (s === 'BULL_TRAP' ? '✅ ' : '') + '🐻 Bull Trap', callback_data: 'strat_bull' }, { text: (s === 'SOCIAL_PROOF_AIRDROP' ? '✅ ' : '') + '🎁 Airdrop', callback_data: 'strat_airdrop' }],
            [{ text: '« Back', callback_data: 'back_to_main' }]
        ] } }
    );
}

function showSettingsMenu(chatId) {
    bot.sendMessage(chatId,
        `⚙️ *CONFIGURATION*\n━━━━━━━━━━━━━━━━━━━━━━━\n\nSelect configuration category:`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
            [{ text: '📱 Basic', callback_data: 'settings_basic' }, { text: '⚡ Advanced', callback_data: 'settings_advanced' }],
            [{ text: '🎯 Strategy', callback_data: 'settings_strat' }, { text: '🎭 Realism', callback_data: 'show_realism' }],
            [{ text: '🔌 Provider', callback_data: 'provider_settings' }, { text: '🛡️ Jito', callback_data: 'settings_jito' }],
            [{ text: '🕸️ Stealth', callback_data: 'stealth_settings' }, { text: '« Back', callback_data: 'back_to_main' }]
        ] } }
    );
}

function showStealthSettings(chatId) {
    bot.sendMessage(chatId,
        `🕸️ *Stealth Funding Settings*\n\n• Web Funding: ${STATE.useWebFunding ? '🟢 ON' : '🔴 OFF'}\n• Stealth Level: ${STATE.fundingStealthLevel === 2 ? '🌪️ Multi-hop (max obfuscation)' : '📡 Direct (fast, traceable)'}\n• Max Hop Depth: \`${STATE.makerFundingChainDepth}\``,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
            [{ text: `Toggle Web Funding ${STATE.useWebFunding ? '🔴' : '🟢'}`, callback_data: 'toggle_web_funding' }],
            [{ text: `Set Stealth Level ${STATE.fundingStealthLevel === 2 ? '➡️ Direct' : '⬅️ Multi-hop'}`, callback_data: 'toggle_stealth_level' }],
            [{ text: '🔗 Set Max Hop Depth', callback_data: 'set_maker_depth' }],
            [{ text: '🔙 Back', callback_data: 'settings' }]
        ] } }
    );
}

function showBasicSettings(chatId) {
    const tokenStatus = STATE.tokenAddress ? `\`${STATE.tokenAddress.substring(0,8)}...${STATE.tokenAddress.substring(STATE.tokenAddress.length-4)}\`` : '❌ Not Set';
    bot.sendMessage(chatId,
        `📱 *BASIC CONFIG*\n━━━━━━━━━━━━━━━━━━━━━━━\n\n🪙 *Token:* ${tokenStatus}\n💰 *Buy Range:* \`${STATE.minBuyAmount}\` - \`${STATE.maxBuyAmount}\` SOL\n🔁 *Cycles:* \`${STATE.numberOfCycles}\`\n⏱ *Delay:* \`${STATE.intervalBetweenActions / 1000}s\`\n🎲 *Jitter:* \`${STATE.jitterPercentage}%\``,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
            [{ text: '🪙 Token Address', callback_data: 'set_token_address' }],
            [{ text: '💰 Min Buy', callback_data: 'set_min_buy' }, { text: '💰 Max Buy', callback_data: 'set_max_buy' }],
            [{ text: '🔁 Cycles', callback_data: 'set_cycles' }, { text: '🎲 Jitter', callback_data: 'set_jitter' }],
            [{ text: '⏱ Delay', callback_data: 'set_interval' }],
            [{ text: '« Back', callback_data: 'settings' }]
        ] } }
    );
}

function showAdvancedSettings(chatId) {
    bot.sendMessage(chatId,
        `⚡ *Advanced Engine Settings*\n\n• Priority Fee: \`${STATE.priorityFee}\` SOL\n• Slippage: \`${STATE.slippage}%\`\n• Batch Concurrency: \`${STATE.batchConcurrency}\`\n• Wallets/Cycle: \`${STATE.walletsPerCycle}\` (Pool Mode)\n• Max Sync Buys/Sells: \`${STATE.maxSimultaneousBuys}/${STATE.maxSimultaneousSells}\``,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
            [{ text: '💸 Priority Fee', callback_data: 'set_fees' }, { text: '📉 Slippage', callback_data: 'set_slippage' }],
            [{ text: '⚡ Concurrency', callback_data: 'set_batch_concurrency' }, { text: '👥 Wallets/Cycle', callback_data: 'set_wallets_per_cycle' }],
            [{ text: '🔄 Buy/Sell Sync', callback_data: 'set_sync' }],
            [{ text: '🔙 Back', callback_data: 'settings' }]
        ] } }
    );
}

function showStrategyConfigMenu(chatId) {
    bot.sendMessage(chatId,
        `🎯 *Strategy-Specific Tuning*\nFine-tune requirements for deep strategies:`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
            [{ text: '📈 Maker Config', callback_data: 'conf_maker' }, { text: '⚡ Spam Config', callback_data: 'conf_spam' }],
            [{ text: '🐋 Whale/Holder', callback_data: 'conf_whale' }, { text: '📐 Chart Pattern', callback_data: 'set_chart_pattern' }],
            [{ text: '🔥 Trending', callback_data: 'conf_trending' }, { text: '🕸️ Social/Manip', callback_data: 'conf_manip' }],
            [{ text: '🔙 Back', callback_data: 'settings' }]
        ] } }
    );
}

function showMakerConfig(chatId) {
    bot.sendMessage(chatId,
        `📈 *Maker Strategy Config*\n\n• Wallets to Generate: \`${STATE.makerWalletsToGenerate}\` (Non-Pool)\n• Funding Depth: \`${STATE.makerFundingChainDepth}\` hops`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
            [{ text: '👥 Wallets to Gen', callback_data: 'set_maker_wallets' }],
            [{ text: '🔗 Funding Depth', callback_data: 'set_maker_depth' }],
            [{ text: '🔙 Back', callback_data: 'settings_strat' }]
        ] } }
    );
}

function showWhaleHolderConfig(chatId) {
    bot.sendMessage(chatId,
        `🐋 *Whale & Holder Simulation*\n\n• Holder Wallets: \`${STATE.holderWallets}\`\n• Holder Buy: \`${STATE.holderBuyAmount}\` SOL\n• Whale Buy: \`${STATE.whaleBuyAmount}\` SOL\n• Whale Dump: \`${STATE.whaleSellPercent}%\``,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
            [{ text: '👥 Holder Wallets', callback_data: 'set_holder_wallets' }, { text: '💵 Holder Buy', callback_data: 'set_holder_buy' }],
            [{ text: '🐋 Whale Buy', callback_data: 'set_whale_buy' }, { text: '🔴 Whale Dump %', callback_data: 'set_whale_dump' }],
            [{ text: '🔙 Back', callback_data: 'settings_strat' }]
        ] } }
    );
}

function showTrendingConfig(chatId) {
    bot.sendMessage(chatId,
        `🔥 *Trending Engine Config*\n\n• Mode: *${STATE.trendingMode}*\n• Intensity: \`${STATE.trendingIntensity}/10\``,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
            [{ text: '🔥 Mode', callback_data: 'set_trending_mode' }, { text: '⚡ Intensity', callback_data: 'set_trending_intensity' }],
            [{ text: '🔙 Back', callback_data: 'settings_strat' }]
        ] } }
    );
}

function showManipConfig(chatId) {
    bot.sendMessage(chatId,
        `🕸️ *Manipulation Strategy Config*\n\n• KOL Swarm Size: \`${STATE.kolRetailSwarmSize}\`\n• Airdrop Count: \`${STATE.airdropWalletCount}\`\n• Bull Trap Slip: \`${STATE.bullTrapSlippage}%\``,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
            [{ text: '🧪 KOL Swarm', callback_data: 'set_kol_swarm' }],
            [{ text: '🕸️ Airdrop Count', callback_data: 'set_airdrop_count' }],
            [{ text: '🐻 Bull Trap Slip', callback_data: 'set_bull_trap_slip' }],
            [{ text: '🔙 Back', callback_data: 'settings_strat' }]
        ] } }
    );
}

function showJitoSettings(chatId) {
    bot.sendMessage(chatId,
        `🛡️ *Jito MEV Protection*\n\n• Status: *${STATE.useJito ? '🟢 ENABLED (Private)' : '🔴 DISABLED (Public)'}*\n• Tip Amount: \`${STATE.jitoTipAmount}\` SOL`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
            [{ text: `Toggle Jito ${STATE.useJito ? '🔴' : '🟢'}`, callback_data: 'set_jito' }],
            [{ text: '💵 Set Jito Tip', callback_data: 'set_jito_tip' }],
            [{ text: '🔙 Back', callback_data: 'settings' }]
        ] } }
    );
}

function showWalletPoolMenu(chatId) {
    const stats = walletPool.getStats();
    const modeIcon = STATE.useWalletPool ? '🟢' : '🔴';
    const modeText = STATE.useWalletPool ? 'ENABLED' : 'DISABLED';
    bot.sendMessage(chatId,
        `💼 *WALLET POOL*\n━━━━━━━━━━━━━━━━━━━━━━━\n\n📊 *Total Wallets:* \`${stats.total.toLocaleString()}\`\n${modeIcon} *Status:* ${modeText}\n⚡ *Concurrency:* \`${STATE.batchConcurrency}\`\n👥 *Wallets/Cycle:* \`${STATE.walletsPerCycle}\`\n💵 *Fund Amount:* \`${STATE.fundAmountPerWallet}\` SOL\n\n${stats.total > 0 ? `Sample: \`${stats.firstFew[0]?.substring(0,8)}...\`` : `⚠️ No wallets yet`}`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
            [{ text: '🔨 Generate', callback_data: 'pool_generate' }],
            [{ text: '💰 Fund All', callback_data: 'pool_fund' }, { text: '🔄 Drain All', callback_data: 'pool_drain' }],
            [{ text: '📊 Scan', callback_data: 'pool_scan' }, { text: `${STATE.useWalletPool ? '🔴 Disable' : '🟢 Enable'}`, callback_data: 'pool_toggle' }],
            [{ text: '⚡ Concurrency', callback_data: 'set_batch_concurrency' }, { text: '👥 Per Cycle', callback_data: 'set_wallets_per_cycle' }],
            [{ text: '💵 Fund Amt', callback_data: 'set_fund_amount' }, { text: '🗑️ Clear', callback_data: 'pool_clear' }],
            [{ text: '« Back', callback_data: 'back_to_main' }]
        ] } }
    );
}

function showProviderMenu(chatId) {
    const p = STATE.swapProvider;
    bot.sendMessage(chatId,
        `🔌 *Select Swap Provider*\nCurrent: *${p}*\nTarget DEX: \`${STATE.targetDex}\``,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
            [{ text: (p === 'SOLANA_TRACKER' ? '✅ ' : '') + '🌐 SolanaTracker (Aggregator)', callback_data: 'prov_tracker' }],
            [{ text: (p === 'SOLANA_TRADE' ? '✅ ' : '') + '🎯 SolanaTrade (Targeted DEX)', callback_data: 'prov_trade' }],
            [{ text: '🎯 Select Target DEX', callback_data: 'select_dex' }],
            [{ text: '🔙 Back', callback_data: 'settings' }]
        ] } }
    );
}

function showDexMenu(chatId) {
    const current = STATE.targetDex;
    const dexes = [
        ['PUMP_FUN', 'Pump.fun'], ['PUMP_SWAP', 'Pump Swap'],
        ['RAYDIUM_AMM', 'Raydium AMM'], ['RAYDIUM_CLMM', 'Raydium CLMM'],
        ['RAYDIUM_CPMM', 'Raydium CPMM'], ['RAYDIUM_LAUNCHPAD', 'Raydium Launch'],
        ['ORCA_WHIRLPOOL', 'Orca Whirlpool'], ['METEORA_DLMM', 'Meteora DLMM'],
        ['METEORA_DAMM_V1', 'Meteora V1'], ['METEORA_DAMM_V2', 'Meteora V2'],
        ['METEORA_DBC', 'Meteora DBC'], ['MOONIT', 'Moonit'],
        ['HEAVEN', 'Heaven'], ['SUGAR', 'Sugar'], ['BOOP_FUN', 'Boop.fun']
    ];
    const keyboard = [];
    for (let i = 0; i < dexes.length; i += 2) {
        const row = [];
        const [val1, label1] = dexes[i];
        row.push({ text: (current === val1 ? '✅ ' : '') + label1, callback_data: `dex_${val1}` });
        if (i + 1 < dexes.length) {
            const [val2, label2] = dexes[i + 1];
            row.push({ text: (current === val2 ? '✅ ' : '') + label2, callback_data: `dex_${val2}` });
        }
        keyboard.push(row);
    }
    keyboard.push([{ text: '🔙 Back', callback_data: 'provider_settings' }]);
    bot.sendMessage(chatId, `🎯 *Select Target DEX* (SolanaTrade only)\nCurrent: *${current}*`, {
        parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard }
    });
}

function showRealismMenu(chatId) {
    bot.sendMessage(chatId,
        `🎭 *Advanced Realism & Stealth Engine*\n\n• Engine Status: ${STATE.realismMode ? '🟢 ON' : '🔴 OFF'}\n• Humanized Delays: ${STATE.humanizedDelays ? '🟢 ON' : '🔴 OFF'}\n• Poisson Timing: ${STATE.usePoissonTiming ? '🟢 ON' : '🔴 OFF'}\n• Variable Slippage: ${STATE.variableSlippage ? '🟢 ON' : '🔴 OFF'}\n• Volume Curve: ${STATE.useVolumeCurve ? '🟢 ON' : '🔴 OFF'}`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
            [{ text: `Toggle Engine ${STATE.realismMode ? '🔴' : '🟢'}`, callback_data: 'toggle_realism' }],
            [{ text: `Human Delays ${STATE.humanizedDelays ? '🔴' : '🟢'}`, callback_data: 'toggle_delays' }],
            [{ text: `Poisson Timing ${STATE.usePoissonTiming ? '🔴' : '🟢'}`, callback_data: 'toggle_poisson' }],
            [{ text: `Variable Slip ${STATE.variableSlippage ? '🔴' : '🟢'}`, callback_data: 'toggle_varslip' }],
            [{ text: `Volume Curve ${STATE.useVolumeCurve ? '🔴' : '🟢'}`, callback_data: 'toggle_vol_curve' }],
            [{ text: '🔙 Back', callback_data: 'settings' }]
        ] } }
    );
}

// ---------- Telegram Callback Handler ----------
bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const action = callbackQuery.data;

    if (!isAdmin(chatId)) return bot.answerCallbackQuery(callbackQuery.id, { text: "⛔ Unauthorized.", show_alert: true });
    if (isRateLimited(chatId)) return bot.answerCallbackQuery(callbackQuery.id, { text: "⏳ Please wait before using another command.", show_alert: false });
    bot.answerCallbackQuery(callbackQuery.id);

    // Engine Control
    if (action === 'start_cycles') {
        if (STATE.running) return bot.sendMessage(chatId, `🔄 Already running! Stop first.`);
        startEngine(chatId);
    } else if (action === 'stop_cycles') {
        STATE.running = false;
        bot.sendMessage(chatId, `🛑 Stopping after current action completes...`);
    }
    // Navigation
    else if (action === 'strategies') showStrategyMenu(chatId);
    else if (action === 'settings') showSettingsMenu(chatId);
    else if (action === 'settings_basic') showBasicSettings(chatId);
    else if (action === 'settings_advanced') showAdvancedSettings(chatId);
    else if (action === 'settings_strat') showStrategyConfigMenu(chatId);
    else if (action === 'settings_jito') showJitoSettings(chatId);
    else if (action === 'stealth_settings') showStealthSettings(chatId);
    else if (action === 'conf_maker') showMakerConfig(chatId);
    else if (action === 'conf_whale') showWhaleHolderConfig(chatId);
    else if (action === 'conf_trending') showTrendingConfig(chatId);
    else if (action === 'conf_manip') showManipConfig(chatId);
    else if (action === 'conf_spam') {
        bot.sendMessage(chatId, `⚡ *Spam Strategy Config*\n\n• Micro-Buy Amount: \`${STATE.spamMicroBuyAmount}\` SOL`, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '⚡ Set Spam Amount', callback_data: 'set_spam_amount' }], [{ text: '🔙 Back', callback_data: 'settings_strat' }]] }
        });
    }
    else if (action === 'back_to_main') showMainMenu(chatId);
    else if (action === 'provider_settings') showProviderMenu(chatId);
    else if (action === 'select_dex') showDexMenu(chatId);
    else if (action === 'show_realism') showRealismMenu(chatId);
    else if (action === 'wallet_pool') showWalletPoolMenu(chatId);
    else if (action === 'toggle_web_funding') {
        STATE.useWebFunding = !STATE.useWebFunding;
        bot.sendMessage(chatId, `✅ Web Funding: ${STATE.useWebFunding ? 'ON' : 'OFF'}`);
        showStealthSettings(chatId);
    }
    else if (action === 'toggle_stealth_level') {
        STATE.fundingStealthLevel = STATE.fundingStealthLevel === 2 ? 1 : 2;
        bot.sendMessage(chatId, `✅ Stealth Level set to ${STATE.fundingStealthLevel === 2 ? 'Multi-hop (max obfuscation)' : 'Direct (fast, traceable)'}`);
        showStealthSettings(chatId);
    }

    // Wallet Pool Operations (same as before, using promptSetting)
    else if (action === 'pool_generate') {
        promptSetting(chatId, `🔨 Enter number of wallets to generate (e.g. \`1000\`, \`10000\`, \`50000\`):\n\nCurrent pool: \`${walletPool.size}\` wallets\n_New wallets will be added to existing pool._`, async (val) => {
            const count = parseInt(val);
            if (isNaN(count) || count <= 0) return bot.sendMessage(chatId, `❌ Invalid number.`);
            if (count > 100000) return bot.sendMessage(chatId, `❌ Maximum 100,000 wallets per generation.`);
            bot.sendMessage(chatId, `⏳ Generating ${count.toLocaleString()} wallets... (this may take a moment)`);
            const generated = await walletPool.generateWallets(count, (p) => {
                if (p.generated % 5000 === 0 || p.generated === p.total) {
                    bot.sendMessage(chatId, `🔨 Generated ${p.generated.toLocaleString()}/${p.total.toLocaleString()}...`);
                }
            });
            bot.sendMessage(chatId, `✅ Generated *${generated.toLocaleString()}* wallets!\nTotal pool: *${walletPool.size.toLocaleString()}* wallets.\nSaved to \`wallets.json\`.`, { parse_mode: 'Markdown' });
            showWalletPoolMenu(chatId);
        });
    }
    else if (action === 'pool_fund') {
        if (walletPool.size === 0) return bot.sendMessage(chatId, `❌ No wallets in pool. Generate first!`);
        if (!masterKeypair) return bot.sendMessage(chatId, `❌ No master wallet loaded.`);
        const estCost = (walletPool.size * STATE.fundAmountPerWallet).toFixed(2);
        promptSetting(chatId, `💰 *Fund All Pool Wallets*\n\nPool: \`${walletPool.size.toLocaleString()}\` wallets\nAmount per wallet: \`${STATE.fundAmountPerWallet}\` SOL\n*Estimated total cost: \`${estCost}\` SOL + fees*\n\nReply \`YES\` to proceed or \`NO\` to cancel:`, async (val) => {
            if (val.toUpperCase() !== 'YES') return bot.sendMessage(chatId, `❌ Funding cancelled.`);
            const connection = getConnection();
            bot.sendMessage(chatId, `💰 Funding ${walletPool.size.toLocaleString()} wallets with \`${STATE.fundAmountPerWallet}\` SOL each (concurrency: ${STATE.batchConcurrency})...`);
            const result = await walletPool.fundAll(
                connection, masterKeypair, sendSOL, STATE.fundAmountPerWallet, STATE.batchConcurrency,
                (p) => {
                    const interval = Math.max(1, Math.floor(p.total / 10));
                    if (p.completed % interval === 0 || p.completed === p.total) {
                        bot.sendMessage(chatId, `💰 Funding: ${p.completed}/${p.total} | ✅ ${p.successes} | ❌ ${p.failures}${p.skipped ? ` | ⏭️ ${p.skipped} skipped` : ''}`);
                    }
                },
                () => true
            );
            bot.sendMessage(chatId, `✅ Funding complete!\n✅ ${result.successes} funded | ❌ ${result.failures} failed`, { parse_mode: 'Markdown' });
            showWalletPoolMenu(chatId);
        });
    }
    else if (action === 'pool_drain') {
        if (walletPool.size === 0) return bot.sendMessage(chatId, `❌ No wallets in pool.`);
        if (!masterKeypair) return bot.sendMessage(chatId, `❌ No master wallet loaded.`);
        const connection = getConnection();
        bot.sendMessage(chatId, `🔄 Draining ${walletPool.size.toLocaleString()} wallets back to master (concurrency: ${STATE.batchConcurrency})...`);
        const result = await walletPool.drainAll(
            connection, masterKeypair, sendSOL, STATE.batchConcurrency,
            (p) => {
                const interval = Math.max(1, Math.floor(p.total / 10));
                if (p.completed % interval === 0 || p.completed === p.total) {
                    bot.sendMessage(chatId, `🔄 Draining: ${p.completed}/${p.total} | ✅ ${p.successes} | ❌ ${p.failures}`);
                }
            },
            () => true
        );
        bot.sendMessage(chatId, `✅ Drain complete! ✅ ${result.successes} drained | ❌ ${result.failures} failed`);
        showWalletPoolMenu(chatId);
    }
    else if (action === 'pool_scan') {
        if (walletPool.size === 0) return bot.sendMessage(chatId, `❌ No wallets in pool.`);
        const connection = getConnection();
        bot.sendMessage(chatId, `📊 Scanning balances of ${walletPool.size.toLocaleString()} wallets...`);
        const scan = await walletPool.scanBalances(connection, STATE.batchConcurrency);
        bot.sendMessage(chatId,
            `📊 *Wallet Pool Scan Results*\n\nTotal Wallets: \`${walletPool.size.toLocaleString()}\`\nFunded: \`${scan.funded.toLocaleString()}\`\nEmpty: \`${scan.empty.toLocaleString()}\`\nTotal SOL: \`${scan.totalSOL.toFixed(4)}\`\nAvg SOL/wallet: \`${(scan.totalSOL / Math.max(1, walletPool.size)).toFixed(6)}\``,
            { parse_mode: 'Markdown' }
        );
    }
    else if (action === 'pool_toggle') {
        STATE.useWalletPool = !STATE.useWalletPool;
        bot.sendMessage(chatId, `✅ Wallet Pool Mode: *${STATE.useWalletPool ? 'ON' : 'OFF'}*`, { parse_mode: 'Markdown' });
        showWalletPoolMenu(chatId);
    }
    else if (action === 'pool_clear') {
        if (walletPool.size === 0) return bot.sendMessage(chatId, `❌ Pool is already empty.`);
        promptSetting(chatId, `⚠️ *Clear ALL ${walletPool.size.toLocaleString()} wallets?*\n\n_This will delete all keypairs from memory and disk. Make sure you've drained SOL first!_\n\nReply \`DELETE\` to confirm:`, (val) => {
            if (val.toUpperCase() !== 'DELETE') return bot.sendMessage(chatId, `❌ Clear cancelled.`);
            walletPool.clearAll();
            bot.sendMessage(chatId, `✅ Wallet pool cleared. All keypairs deleted.`);
            showWalletPoolMenu(chatId);
        });
    }
    else if (action === 'set_fund_amount') {
        promptSetting(chatId, `Reply with *SOL per wallet* for pool funding (e.g. \`0.01\`):`, (val) => {
            STATE.fundAmountPerWallet = parseFloat(val);
            bot.sendMessage(chatId, `✅ Fund Amount: \`${STATE.fundAmountPerWallet}\` SOL/wallet`, { parse_mode: 'Markdown' });
            showWalletPoolMenu(chatId);
        });
    }
    else if (action === 'set_batch_concurrency') {
        promptSetting(chatId, `Reply with *Batch Concurrency* (max parallel TXs, e.g. \`10\`, \`20\`, \`50\`):`, (val) => {
            STATE.batchConcurrency = Math.max(1, Math.min(100, parseInt(val)));
            bot.sendMessage(chatId, `✅ Batch Concurrency: \`${STATE.batchConcurrency}\``, { parse_mode: 'Markdown' });
            showSettingsMenu(chatId);
        });
    }
    else if (action === 'set_wallets_per_cycle') {
        promptSetting(chatId, `Reply with *Wallets Per Cycle* (how many pool wallets per strategy cycle, e.g. \`50\`, \`500\`, \`5000\`):`, (val) => {
            STATE.walletsPerCycle = Math.max(1, parseInt(val));
            bot.sendMessage(chatId, `✅ Wallets/Cycle: \`${STATE.walletsPerCycle}\``, { parse_mode: 'Markdown' });
            showSettingsMenu(chatId);
        });
    }
    // Strategy Selection
    else if (action.startsWith('strat_')) {
        const stratMap = { 
            'strat_standard': 'STANDARD', 'strat_maker': 'MAKER', 'strat_web': 'WEB_OF_ACTIVITY',
            'strat_spam': 'SPAM', 'strat_pumpdump': 'PUMP_DUMP', 'strat_chart': 'CHART_PATTERN',
            'strat_holder': 'HOLDER_GROWTH', 'strat_whale': 'WHALE', 'strat_volume': 'VOLUME_BOOST',
            'strat_trending': 'TRENDING', 'strat_mev_wash': 'JITO_MEV_WASH', 'strat_kol': 'KOL_ALPHA_CALL',
            'strat_bull': 'BULL_TRAP', 'strat_airdrop': 'SOCIAL_PROOF_AIRDROP'
        };
        STATE.strategy = stratMap[action] || 'STANDARD';
        bot.sendMessage(chatId, `✅ Strategy: *${STATE.strategy}*`, { parse_mode: 'Markdown' });
        showStrategyMenu(chatId);
    }
    // Provider & DEX
    else if (action === 'prov_tracker') {
        STATE.swapProvider = 'SOLANA_TRACKER';
        bot.sendMessage(chatId, `✅ Provider set to: *SolanaTracker*`, { parse_mode: 'Markdown' });
        showProviderMenu(chatId);
    }
    else if (action === 'prov_trade') {
        STATE.swapProvider = 'SOLANA_TRADE';
        bot.sendMessage(chatId, `✅ Provider set to: *SolanaTrade*`, { parse_mode: 'Markdown' });
        showProviderMenu(chatId);
    }
    else if (action.startsWith('dex_')) {
        STATE.targetDex = action.replace('dex_', '');
        bot.sendMessage(chatId, `✅ Target DEX set to: *${STATE.targetDex}*`, { parse_mode: 'Markdown' });
        showDexMenu(chatId);
    }
    // Settings Handlers with validation
    else if (action === 'set_token_address') {
        promptSetting(chatId, `Reply with the *Token Address (CA)*:`, (val) => {
            if (!val || val.length < 32) {
                bot.sendMessage(chatId, "❌ Invalid CA.");
                return;
            }
            STATE.tokenAddress = val;
            bot.sendMessage(chatId, `✅ Token CA set to:\n\`${STATE.tokenAddress}\``, { parse_mode: "Markdown" });
            showBasicSettings(chatId);
        });
    }
    else if (action === 'toggle_realism') { STATE.realismMode = !STATE.realismMode; showRealismMenu(chatId); }
    else if (action === 'toggle_delays') { STATE.humanizedDelays = !STATE.humanizedDelays; showRealismMenu(chatId); }
    else if (action === 'toggle_varslip') { STATE.variableSlippage = !STATE.variableSlippage; showRealismMenu(chatId); }
    else if (action === 'toggle_poisson') { STATE.usePoissonTiming = !STATE.usePoissonTiming; showRealismMenu(chatId); }
    else if (action === 'toggle_vol_curve') { STATE.useVolumeCurve = !STATE.useVolumeCurve; showRealismMenu(chatId); }
    else if (action === 'set_min_buy') {
        promptSetting(chatId, `Reply with *Min Buy Amount* in SOL (0.0005 - 10):`, (val) => {
            try { STATE.minBuyAmount = validateNumber(val, 0.0005, 10, "Min Buy"); bot.sendMessage(chatId, `✅ Min Buy: \`${STATE.minBuyAmount}\` SOL`); } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showBasicSettings(chatId);
        });
    }
    else if (action === 'set_max_buy') {
        promptSetting(chatId, `Reply with *Max Buy Amount* in SOL (0.0005 - 10):`, (val) => {
            try { STATE.maxBuyAmount = validateNumber(val, 0.0005, 10, "Max Buy"); if (STATE.maxBuyAmount < STATE.minBuyAmount) throw new Error("Max Buy must be >= Min Buy"); bot.sendMessage(chatId, `✅ Max Buy: \`${STATE.maxBuyAmount}\` SOL`); } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showBasicSettings(chatId);
        });
    }
    else if (action === 'set_cycles') {
        promptSetting(chatId, `Reply with total *Action Cycles* (1 - 1000):`, (val) => {
            try { STATE.numberOfCycles = validateNumber(val, 1, 1000, "Cycles"); bot.sendMessage(chatId, `✅ Cycles: \`${STATE.numberOfCycles}\``); } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showBasicSettings(chatId);
        });
    }
    else if (action === 'set_jito') { STATE.useJito = !STATE.useJito; bot.sendMessage(chatId, `✅ Jito Protect: *${STATE.useJito ? 'ON' : 'OFF'}*`); showJitoSettings(chatId); }
    else if (action === 'set_jito_tip') {
        promptSetting(chatId, `Reply with *Jito Tip* in SOL (0.00001 - 0.1):`, (val) => {
            try { STATE.jitoTipAmount = validateNumber(val, 0.00001, 0.1, "Jito Tip"); bot.sendMessage(chatId, `✅ Jito Tip: \`${STATE.jitoTipAmount}\` SOL`); } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showJitoSettings(chatId);
        });
    }
    else if (action === 'set_fees') {
        promptSetting(chatId, `Reply with *Priority Fee* in SOL (0 - 0.01):`, (val) => {
            try { STATE.priorityFee = validateNumber(val, 0, 0.01, "Priority Fee"); bot.sendMessage(chatId, `✅ Fee: \`${STATE.priorityFee}\` SOL`); } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showAdvancedSettings(chatId);
        });
    }
    else if (action === 'set_slippage') {
        promptSetting(chatId, `Reply with *Slippage %* (0.5 - 50):`, (val) => {
            try { STATE.slippage = validateNumber(val, 0.5, 50, "Slippage"); bot.sendMessage(chatId, `✅ Slippage: \`${STATE.slippage}%\``); } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showAdvancedSettings(chatId);
        });
    }
    else if (action === 'set_jitter') {
        promptSetting(chatId, `Reply with *Jitter %* (0 - 100):`, (val) => {
            try { STATE.jitterPercentage = validateNumber(val, 0, 100, "Jitter"); bot.sendMessage(chatId, `✅ Jitter: \`${STATE.jitterPercentage}%\``); } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showBasicSettings(chatId);
        });
    }
    else if (action === 'set_interval') {
        promptSetting(chatId, `Reply with *Base Delay* in seconds (1 - 300):`, (val) => {
            try { const sec = validateNumber(val, 1, 300, "Delay"); STATE.intervalBetweenActions = sec * 1000; bot.sendMessage(chatId, `✅ Delay: \`${sec}s\``); } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showBasicSettings(chatId);
        });
    }
    else if (action === 'set_maker_wallets') {
        promptSetting(chatId, `Reply with number of *Maker Wallets* to generate (1 - 100):`, (val) => {
            try { STATE.makerWalletsToGenerate = validateNumber(val, 1, 100, "Maker Wallets"); bot.sendMessage(chatId, `✅ Maker Wallets: \`${STATE.makerWalletsToGenerate}\``); } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showMakerConfig(chatId);
        });
    }
    else if (action === 'set_maker_depth') {
        promptSetting(chatId, `Reply with *Funding Chain Depth* (1 - 5):`, (val) => {
            try { STATE.makerFundingChainDepth = validateNumber(val, 1, 5, "Funding Depth"); bot.sendMessage(chatId, `✅ Funding Depth: \`${STATE.makerFundingChainDepth}\``); } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showMakerConfig(chatId);
        });
    }
    else if (action === 'set_sync') {
        promptSetting(chatId, `Reply with *Max Concurrent Buys & Sells* (e.g. \`2 2\`):`, (val) => {
            const parts = val.trim().split(/\s+/);
            if (parts.length >= 2) {
                STATE.maxSimultaneousBuys = parseInt(parts[0]);
                STATE.maxSimultaneousSells = parseInt(parts[1]);
                bot.sendMessage(chatId, `✅ Buys: \`${STATE.maxSimultaneousBuys}\` | Sells: \`${STATE.maxSimultaneousSells}\``);
            } else { bot.sendMessage(chatId, `❌ Invalid format. Use: \`2 2\``); }
            showAdvancedSettings(chatId);
        });
    }
    else if (action === 'set_spam_amount') {
        promptSetting(chatId, `Reply with *Micro-Spam Buy Amount* in SOL (0.00001 - 0.01):`, (val) => {
            try { STATE.spamMicroBuyAmount = validateNumber(val, 0.00001, 0.01, "Spam Amount"); bot.sendMessage(chatId, `✅ Spam Amount: \`${STATE.spamMicroBuyAmount}\` SOL`); } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            bot.sendMessage(chatId, `⚡ *Spam Strategy Config*\n\n• Micro-Buy Amount: \`${STATE.spamMicroBuyAmount}\` SOL`, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '⚡ Set Spam Amount', callback_data: 'set_spam_amount' }], [{ text: '🔙 Back', callback_data: 'settings_strat' }]] }
            });
        });
    }
    else if (action === 'set_chart_pattern') {
        const patterns = ['ASCENDING', 'DESCENDING', 'SIDEWAYS', 'CUP_HANDLE', 'BREAKOUT'];
        bot.sendMessage(chatId, `📐 *Select Chart Pattern*\nCurrent: *${STATE.chartPattern}*`, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: patterns.map(p => [{ text: (STATE.chartPattern === p ? '✅ ' : '') + p, callback_data: `cpat_${p}` }]).concat([[{ text: '🔙 Back', callback_data: 'settings' }]]) }
        });
    }
    else if (action.startsWith('cpat_')) { STATE.chartPattern = action.replace('cpat_', ''); bot.sendMessage(chatId, `✅ Chart Pattern: *${STATE.chartPattern}*`); showSettingsMenu(chatId); }
    else if (action === 'set_holder_wallets') {
        promptSetting(chatId, `Reply with *number of holder wallets* (1 - 1000):`, (val) => {
            try { STATE.holderWallets = validateNumber(val, 1, 1000, "Holder Wallets"); bot.sendMessage(chatId, `✅ Holder Wallets: \`${STATE.holderWallets}\``); } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showWhaleHolderConfig(chatId);
        });
    }
    else if (action === 'set_holder_buy') {
        promptSetting(chatId, `Reply with *SOL per holder wallet* (0.001 - 1):`, (val) => {
            try { STATE.holderBuyAmount = validateNumber(val, 0.001, 1, "Holder Buy"); bot.sendMessage(chatId, `✅ Holder Buy: \`${STATE.holderBuyAmount}\` SOL`); } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showWhaleHolderConfig(chatId);
        });
    }
    else if (action === 'set_whale_buy') {
        promptSetting(chatId, `Reply with *Whale Buy Amount* in SOL (0.1 - 100):`, (val) => {
            try { STATE.whaleBuyAmount = validateNumber(val, 0.1, 100, "Whale Buy"); bot.sendMessage(chatId, `✅ Whale Buy: \`${STATE.whaleBuyAmount}\` SOL`); } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showWhaleHolderConfig(chatId);
        });
    }
    else if (action === 'set_whale_dump') {
        promptSetting(chatId, `Reply with *Whale Dump %* (1 - 100):`, (val) => {
            try { STATE.whaleSellPercent = validateNumber(val, 1, 100, "Whale Dump %"); bot.sendMessage(chatId, `✅ Whale Dump: \`${STATE.whaleSellPercent}%\``); } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showWhaleHolderConfig(chatId);
        });
    }
    else if (action === 'set_vol_mult') {
        promptSetting(chatId, `Reply with *Volume Boost Multiplier* (1 - 50):`, (val) => {
            try { STATE.volumeBoostMultiplier = validateNumber(val, 1, 50, "Volume Multiplier"); bot.sendMessage(chatId, `✅ Volume Multiplier: \`${STATE.volumeBoostMultiplier}\` wallets`); } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showSettingsMenu(chatId);
        });
    }
    else if (action === 'set_vol_cycles') {
        promptSetting(chatId, `Reply with *Volume Boost Cycles* (1 - 100):`, (val) => {
            try { STATE.volumeBoostCycles = validateNumber(val, 1, 100, "Volume Cycles"); bot.sendMessage(chatId, `✅ Volume Cycles: \`${STATE.volumeBoostCycles}\``); } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showSettingsMenu(chatId);
        });
    }
    else if (action === 'set_vol_range') {
        promptSetting(chatId, `Reply with *Volume Min Max* in SOL (e.g. \`0.005 0.02\`):`, (val) => {
            const parts = val.split(' ');
            if (parts.length >= 2) {
                STATE.volumeBoostMinAmount = parseFloat(parts[0]);
                STATE.volumeBoostMaxAmount = parseFloat(parts[1]);
                bot.sendMessage(chatId, `✅ Volume Range: \`${STATE.volumeBoostMinAmount} - ${STATE.volumeBoostMaxAmount}\` SOL`);
            } else { bot.sendMessage(chatId, `❌ Invalid format. Use: \`0.005 0.02\``); }
            showSettingsMenu(chatId);
        });
    }
    else if (action === 'set_trending_mode') {
        const modes = ['VIRAL_PUMP', 'ORGANIC_GROWTH', 'FOMO_WAVE', 'LIQUIDITY_LADDER', 'WASH_TRADING'];
        bot.sendMessage(chatId, `🔥 *Select Trending Mode*\nCurrent: *${STATE.trendingMode}*`, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: modes.map(m => [{ text: (STATE.trendingMode === m ? '✅ ' : '') + m.replace(/_/g, ' '), callback_data: `tmode_${m}` }]).concat([[{ text: '🔙 Back', callback_data: 'settings' }]]) }
        });
    }
    else if (action.startsWith('tmode_')) { STATE.trendingMode = action.replace('tmode_', ''); bot.sendMessage(chatId, `✅ Trending Mode: *${STATE.trendingMode}*`); showSettingsMenu(chatId); }
    else if (action === 'set_trending_intensity') {
        promptSetting(chatId, `Reply with *Trending Intensity* (1-10):`, (val) => {
            try { STATE.trendingIntensity = validateNumber(val, 1, 10, "Trending Intensity"); bot.sendMessage(chatId, `✅ Trending Intensity: \`${STATE.trendingIntensity}/10\``); } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showSettingsMenu(chatId);
        });
    }
    else if (action === 'set_kol_swarm') {
        promptSetting(chatId, `Reply with *KOL Retail Swarm Size* (1 - 500):`, (val) => {
            try { STATE.kolRetailSwarmSize = validateNumber(val, 1, 500, "KOL Swarm"); bot.sendMessage(chatId, `✅ KOL Swarm: \`${STATE.kolRetailSwarmSize}\``); } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showManipConfig(chatId);
        });
    }
    else if (action === 'set_airdrop_count') {
        promptSetting(chatId, `Reply with *Airdrop Wallet Count* (1 - 1000):`, (val) => {
            try { STATE.airdropWalletCount = validateNumber(val, 1, 1000, "Airdrop Count"); bot.sendMessage(chatId, `✅ Airdrop Count: \`${STATE.airdropWalletCount}\``); } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showManipConfig(chatId);
        });
    }
    else if (action === 'set_bull_trap_slip') {
        promptSetting(chatId, `Reply with *Bull Trap Dump Slippage %* (1 - 50):`, (val) => {
            try { STATE.bullTrapSlippage = validateNumber(val, 1, 50, "Bull Trap Slippage"); bot.sendMessage(chatId, `✅ Bull Trap Slippage: \`${STATE.bullTrapSlippage}%\``); } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showManipConfig(chatId);
        });
    }
    // Dashboard
    else if (action === 'status') {
        if (!masterKeypair) return bot.sendMessage(chatId, `❌ No wallet loaded.`);
        try {
            const connection = getConnection();
            const solBal = await connection.getBalance(masterKeypair.publicKey) / LAMPORTS_PER_SOL;
            let tokenBal = 0;
            if (STATE.tokenAddress) tokenBal = await getTokenBalance(connection, masterKeypair.publicKey, STATE.tokenAddress);
            const estTxs = Math.floor(solBal / (STATE.maxBuyAmount + STATE.priorityFee));
            bot.sendMessage(chatId,
                `📊 *Bot Dashboard*\n\n💰 *Balances*\nSOL: \`${solBal.toFixed(4)}\`\nToken: \`${tokenBal}\`\n\n💼 *Wallet Pool*\nTotal: \`${walletPool.size.toLocaleString()}\` wallets | Mode: *${STATE.useWalletPool ? 'ON' : 'OFF'}*\nConcurrency: \`${STATE.batchConcurrency}\` | Wallets/Cycle: \`${STATE.walletsPerCycle}\`\n\n⚙️ *Config*\nStrategy: *${STATE.strategy}*\nProvider: *${STATE.swapProvider}*\nDEX: *${STATE.targetDex}*\nToken: \`${STATE.tokenAddress || 'Not Set'}\`\nBuy Range: \`${STATE.minBuyAmount} - ${STATE.maxBuyAmount}\` SOL\nFee: \`${STATE.priorityFee}\` | Slip: \`${STATE.slippage}%\`\nJitter: \`${STATE.jitterPercentage}%\` | Delay: \`${STATE.intervalBetweenActions / 1000}s\`\nCycles: \`${STATE.numberOfCycles}\` | Sync: \`${STATE.maxSimultaneousBuys}/${STATE.maxSimultaneousSells}\`\n\n🛡️ Engine: ${STATE.running ? '🟢 ONLINE' : '🔴 OFFLINE'}\n🔁 Est. Max Swaps: \`${estTxs}\``,
                { parse_mode: 'Markdown' }
            );
        } catch (e) { logger.error(`Dashboard error: ${e.message}`); bot.sendMessage(chatId, `⚠️ Could not fetch status: ${e.message}`); }
    }
    // Wallet
    else if (action === 'show_wallet') {
        if (!masterKeypair) return bot.sendMessage(chatId, `❌ No wallet loaded.`);
        const addr = masterKeypair.publicKey.toBase58();
        bot.sendMessage(chatId, `📜 *Master Wallet*\n\`${addr}\`\n\n[View on Solscan](https://solscan.io/account/${addr})`, { parse_mode: 'Markdown' });
    }
    // Help
    else if (action === 'help') {
        bot.sendMessage(chatId,
            `❓ *Advanced Volume Bot - Help*\n\n*Strategies:*\n🌐 *Standard* — Single wallet buy/sell with randomized amounts and jitter.\n📈 *Maker* — Generates child wallets for concurrent buys, boosting Unique Maker count.\n⚡ *Spam* — Rapid micro-buys to inflate transaction count.\n🚀 *Pump & Dump* — Fast accumulation then instant sell.\n\n*Setup:*\n1. Set Token CA in ⚙️ Config\n2. Choose a strategy in 📈 Strategies\n3. Hit 🚀 Launch Engine\n\n*Tips:*\n• Higher Jitter % = more human-like\n• Maker mode uses more SOL (funds child wallets)\n• Use 📊 Dashboard to check balances\n• Stealth funding (multi-hop) obfuscates on-chain links and is safe – intermediates are drained.`,
            { parse_mode: 'Markdown' }
        );
    }
});

bot.onText(/\/start/, (msg) => {
    if (isAdmin(msg.chat.id)) showMainMenu(msg.chat.id);
    else bot.sendMessage(msg.chat.id, "⛔ Unauthorized.");
});

logger.info("Production bot online with stealth funding (no SOL loss) and all safety fixes.");
