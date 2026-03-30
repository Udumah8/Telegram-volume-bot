import fs from "fs";
import 'dotenv/config';
import { Connection, Keypair, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { SolanaTracker } from "solana-swap";
let SolanaTrade; 
try {
    // Dynamic import to prevent boot crash if provider has dependency issues
    const stModule = await import("solana-trade");
    SolanaTrade = stModule.SolanaTrade;
} catch (e) {
    console.warn("⚠️ SolanaTrade provider failed to load (dependency issue). Using SolanaTracker as fallback.");
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
const RPC_URL = RPC_URLS[0];
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
            logger.error(`RPC ${RPC_URLS[currentRpcIndex % RPC_URLS.length]} failed: ${err.message}`);
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
const CONFIG_FILE = 'config.json';

function saveConfig() {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(STATE, null, 4));
    } catch (e) {
        logger.error(`Failed to save config: ${e.message}`);
    }
}

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
            Object.assign(STATE, data);
            logger.info("✅ Configuration loaded from disk.");
        }
    } catch (e) {
        logger.error(`Failed to load config: ${e.message}`);
    }
}

function clearSession(chatId) {
    const cid = chatId.toString();
    const session = userSessions.get(cid);
    if (session) {
        clearTimeout(session.timeout);
        userSessions.delete(cid);
    }
}

// Single message handler for prompts
bot.on('message', (msg) => {
    const chatId = msg.chat.id.toString();
    
    // Help user find their ID if they don't know it
    if (msg.text && (msg.text.toLowerCase().includes('id') || msg.text.toLowerCase().includes('whoami'))) {
        logger.info(`User ID check: Chat ${chatId} (${msg.from?.username || 'unknown'})`);
    }

    const session = userSessions.get(chatId);
    if (!session) return;
    
    // Commands should break prompts
    if (msg.text && msg.text.startsWith('/')) {
        clearSession(chatId);
        return;
    }

    if (!msg.text) return; // Ignore non-text updates (photos, stickers) for prompts

    clearTimeout(session.timeout);
    userSessions.delete(chatId);
    session.callback(msg.text.trim());
});
// ─────────────────────────────────────────────
// Advanced Constants
// ─────────────────────────────────────────────
const PERSONALITIES = {
    DIAMOND: { buyProb: 0.8, sellProb: 0.1, minHold: 5, maxHold: 15, sizeMult: 0.8, minThink: 2000, maxThink: 8000 },
    SCALPER: { buyProb: 0.9, sellProb: 0.8, minHold: 1, maxHold: 3, sizeMult: 1.2, minThink: 500, maxThink: 2500 },
    RETAIL:  { buyProb: 0.5, sellProb: 0.4, minHold: 2, maxHold: 6, sizeMult: 0.5, minThink: 1000, maxThink: 6000 },
    WHALE:   { buyProb: 0.3, sellProb: 0.05, minHold: 10, maxHold: 30, sizeMult: 3.0, minThink: 3000, maxThink: 20000 }
};

const STATE = {
    tokenAddress: "",
    strategy: "STANDARD", 
    swapProvider: "SOLANA_TRACKER",
    targetDex: "RAYDIUM_AMM",
    running: false,

    // Volume Configs
    minBuyAmount: 0.01,
    maxBuyAmount: 0.05,
    priorityFee: 0.0005,
    slippage: 2,
    numberOfCycles: 3,
    maxSimultaneousBuys: 1,
    maxSimultaneousSells: 1,
    intervalBetweenActions: 15000,
    jitterPercentage: 20,
    
    // Realism Engine
    realismMode: true,
    humanizedDelays: true, 
    variableSlippage: true, 
    usePoissonTiming: true, 
    useVolumeCurve: true,
    volCurveIntensity: 1.5,

    // Stealth / Funding
    useWalletPool: true,
    fundAmountPerWallet: 0.01,
    batchConcurrency: 10,
    walletsPerCycle: 50,
    useWebFunding: true,
    fundingStealthLevel: 2,
    makerFundingChainDepth: 2,
    makerWalletsToGenerate: 3,

    // Jito Config
    useJito: false,
    jitoTipAmount: 0.0001,

    // Strategy Specifics
    spamMicroBuyAmount: 0.0001,
    chartPattern: "ASCENDING", // ASCENDING, DESCENDING, SIDEWAYS, CUP_HANDLE, BREAKOUT

    // Holder Growth Simulation
    holderWallets: 5,
    holderBuyAmount: 0.005,

    // Whale Simulation
    whaleBuyAmount: 1.0,
    whaleSellPercent: 80, // % of balance to dump

    // Advanced Volume Boosting
    volumeBoostMultiplier: 3, // how many parallel wallets
    volumeBoostCycles: 10,
    volumeBoostMinAmount: 0.005,
    volumeBoostMaxAmount: 0.02,

    // Trending Strategies
    trendingMode: "VIRAL_PUMP", // VIRAL_PUMP, ORGANIC_GROWTH, FOMO_WAVE, LIQUIDITY_LADDER, WASH_TRADING
    trendingIntensity: 5, // 1-10 scale

    // Advanced Manipulation
    kolRetailSwarmSize: 15,
    airdropWalletCount: 50,
    bullTrapSlippage: 15, // Max slippage for dump

    // Wallet Pool Config (10,000+ wallets)
    walletPoolSize: 100,           // Default generation count
    batchConcurrency: 10,          // Max parallel TXs for pool operations
    running: false
};

function promptSetting(chatId, prompt, callback) {
    const cid = chatId.toString();
    clearSession(cid);
    bot.sendMessage(chatId, prompt, { parse_mode: "Markdown", reply_markup: { force_reply: true } });
    const timeout = setTimeout(() => {
        if (userSessions.has(cid)) {
            userSessions.delete(cid);
            bot.sendMessage(chatId, "⏰ Prompt timed out. Please try again.");
        }
    }, 60000);
    userSessions.set(cid, { action: 'prompt', timeout, callback });
}

// ---------- Rate limiting ----------
const lastCommandTime = new Map();
function isRateLimited(chatId) {
    const cid = chatId.toString();
    const now = Date.now();
    const last = lastCommandTime.get(cid) || 0;
    if (now - last < 500) return true;
    lastCommandTime.set(cid, now);
    return false;
}

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
    // Vary slippage by +/- 1% randomly to avoid fingerprints
    const variance = (Math.random() * 2) - 1; 
    return Math.max(0.5, parseFloat((baseSlippage + variance).toFixed(1)));
}

function getDynamicFee(baseFee) {
    if (!STATE.realismMode) return baseFee;
    // Vary fee slightly to look organic
    const variance = baseFee * ((Math.random() * 0.4) - 0.2); // +/- 20%
    return Math.max(0.00001, parseFloat((baseFee + variance).toFixed(6)));
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function getPoissonDelay(mean) {
    if (!STATE.usePoissonTiming) return mean;
    // Simple Poisson approximation using exponential distribution for inter-arrival times
    return Math.floor(-mean * Math.log(1.0 - Math.random()));
}

function getVolumeMultiplier() {
    if (!STATE.useVolumeCurve) return 1.0;
    const now = new Date();
    const hours = now.getHours() + now.getMinutes() / 60;
    // Create a 24-hour wave (low at 4am, high at 4pm)
    const wave = Math.sin((hours - 10) * (Math.PI / 12)); 
    const multiplier = 1.0 + (wave * 0.5 * STATE.volCurveIntensity);
    // Add some noise
    const noise = (Math.random() * 0.4 - 0.2) * STATE.volCurveIntensity;
    return Math.max(0.1, multiplier + noise);
}

// ---------- SAFE STEALTH FUNDING (multi-hop with drain) ----------
async function fundWeb(connection, from, targets, amountSOL, chatId) {
    const maxDepth = STATE.makerFundingChainDepth;
    const allIntermediates = [];

    bot.sendMessage(chatId, `🕸️ *Stealth Web Funding* for ${targets.length} wallets (max depth ${maxDepth})...`, { parse_mode: 'Markdown' });

    // Parallelize the creation of paths, but each path remains sequential
    await BatchSwapEngine.executeBatch(
        targets,
        async (target, i) => {
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

            let currentAmount = amountSOL + (0.005 * depth);

            for (let j = 0; j < path.length - 1; j++) {
                if (!STATE.running) break;
                const sender = path[j];
                const receiver = path[j + 1];
                try {
                    const txid = await sendSOL(connection, sender, receiver.publicKey, currentAmount);
                    logger.info(`[StealthFund] Target ${i+1} | Hop ${j}: ${sender.publicKey.toBase58().substring(0,4)} → ${receiver.publicKey.toBase58().substring(0,4)}`);
                } catch (err) {
                    logger.error(`Funding break at target ${i+1} hop ${j}: ${err.message}`);
                    break;
                }
                currentAmount -= 0.004;
                await sleep(getPoissonDelay(1500)); // Short pause between hops in a path
            }
        },
        STATE.batchConcurrency,
        (p) => {
            if (p.completed % Math.max(1, Math.floor(p.total / 10)) === 0 || p.completed === p.total) {
                bot.sendMessage(chatId, `🕸️ Stealth Progress: ${p.completed}/${p.total} | ✅ ${p.successes}`);
            }
        },
        () => STATE.running
    );

    if (allIntermediates.length > 0 && STATE.running) {
        bot.sendMessage(chatId, `🧹 Draining ${allIntermediates.length} intermediate wallets...`);
        await BatchSwapEngine.executeBatch(
            allIntermediates,
            async (inter) => {
                const bal = await connection.getBalance(inter.publicKey);
                if (bal > 10000) {
                    await sendSOL(connection, inter, from.publicKey, (bal - 10000) / LAMPORTS_PER_SOL);
                }
            },
            STATE.batchConcurrency,
            null,
            () => STATE.running
        );
    }
    bot.sendMessage(chatId, `✅ Stealth funding complete.`);
}


// ---------- Token Balance Helper ----------
async function getTokenBalance(connection, owner, mint) {
    try {
        if (mint === SOL_ADDR) {
            const bal = await connection.getBalance(owner);
            return bal / LAMPORTS_PER_SOL;
        }
        const accounts = await connection.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(mint) });
        if (accounts.value.length === 0) return 0;
        return accounts.value[0].account.data.parsed.info.tokenAmount.uiAmount || 0;
    } catch (e) {
        return 0;
    }
}

async function drainWallets(connection, wallets, masterPubkey, chatId) {
    if (!wallets || wallets.length === 0) return;
    bot.sendMessage(chatId, `🧹 Draining ${wallets.length} wallets...`);
    await BatchSwapEngine.executeBatch(
        wallets,
        async (w) => {
            const bal = await connection.getBalance(w.publicKey);
            if (bal > 10000) {
                return await sendSOL(connection, w, masterPubkey, (bal - 10000) / LAMPORTS_PER_SOL);
            }
            return null;
        },
        STATE.batchConcurrency,
        null,
        () => STATE.running
    );
    bot.sendMessage(chatId, `✅ Drain complete.`);
}

async function fundWalletsDirect(connection, from, targets, amountSOL, chatId) {
    bot.sendMessage(chatId, `💰 Direct funding ${targets.length} wallets with ${amountSOL} SOL each (parallel)...`);
    await BatchSwapEngine.executeBatch(
        targets,
        async (target) => {
            await sendSOL(connection, from, target.publicKey, amountSOL);
        },
        STATE.batchConcurrency,
        (p) => {
            if (p.completed % Math.max(1, Math.floor(p.total / 10)) === 0 || p.completed === p.total) {
                bot.sendMessage(chatId, `💰 Funding: ${p.completed}/${p.total} | ✅ ${p.successes}`);
            }
        },
        () => STATE.running
    );
    bot.sendMessage(chatId, `✅ Direct funding complete.`);
}

async function fundWallets(connection, from, targets, amountSOL, chatId) {
    if (STATE.useWebFunding && STATE.fundingStealthLevel === 2) {
        await fundWeb(connection, from, targets, amountSOL, chatId);
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

async function swap(tokenIn, tokenOut, keypair, connection, amount, chatId, silent = false) {
    try {
        let cleanAmount;
        if (typeof amount === 'string' && amount === 'auto') {
            cleanAmount = 'auto';
        } else {
            cleanAmount = parseFloat(parseFloat(amount).toFixed(6));
            if (isNaN(cleanAmount) || cleanAmount <= 0) throw new Error(`Invalid amount: ${amount}`);
        }

        const currentSlippage = getDynamicSlippage(STATE.slippage);
        const currentFee = getDynamicFee(STATE.priorityFee);

        if (STATE.swapProvider === "SOLANA_TRADE") {
            if (!SolanaTrade) throw new Error("SolanaTrade provider not loaded.");
            const trade = new SolanaTrade(RPC_URL);
            const isBuy = tokenIn === SOL_ADDR;
            
            const params = {
                market: STATE.targetDex,
                wallet: keypair,
                mint: isBuy ? tokenOut : tokenIn,
                amount: cleanAmount === 'auto' ? (await getTokenBalance(connection, keypair.publicKey, isBuy ? tokenOut : tokenIn)) : cleanAmount,
                slippage: currentSlippage,
                priorityFeeSol: currentFee,
                tipAmountSol: STATE.useJito ? STATE.jitoTipAmount : 0,
                sender: STATE.useJito ? 'JITO' : undefined,
                skipConfirmation: STATE.useJito,
                send: true 
            };
            
            bot.sendMessage(chatId, `⚡ *SolanaTrade* [${STATE.targetDex}] ${isBuy?'Buy':'Sell'} in progress...`, { parse_mode: 'Markdown' });
            const sig = isBuy ? await trade.buy(params) : await trade.sell(params);
            if (!silent && sig) bot.sendMessage(chatId, `✅ Confirmed: https://solscan.io/tx/${sig}`);
            return sig;
        } else {
            const solanaTracker = new SolanaTracker(keypair, RPC_URL);
            const swapResponse = await solanaTracker.getSwapInstructions(
                tokenIn, tokenOut, cleanAmount, currentSlippage, keypair.publicKey.toBase58(), STATE.useJito ? 0 : currentFee, false
            );

            if (!swapResponse || (!swapResponse.txn && !swapResponse.tx)) throw new Error('No transaction returned from API.');

            let txid;
            if (STATE.useJito) {
                 const serializedTx = swapResponse.txn || swapResponse.tx;
                 let b58Tx;
                 if (typeof serializedTx === 'string') {
                    b58Tx = serializedTx;
                 } else {
                    const txBuffer = Buffer.from(serializedTx, 'base64');
                    b58Tx = bs58.encode(txBuffer);
                 }
                 txid = await sendJitoBundle([b58Tx], keypair, connection, STATE.jitoTipAmount);
            } else {
                txid = await solanaTracker.performSwap(swapResponse, {
                    sendOptions: { skipPreflight: true },
                    commitment: "confirmed",
                });
            }

            if (!silent && txid) bot.sendMessage(chatId, `✅ Confirmed: https://solscan.io/tx/${txid}`);
            return txid;
        }
    } catch (e) {
        const errorMsg = e.message || "Unknown error";
        const shortKey = keypair.publicKey.toBase58().substring(0, 8);
        console.error(`Swap error [${shortKey}]:`, errorMsg);
        if (!silent) bot.sendMessage(chatId, `⚠️ Swap failed [${shortKey}...]: ${errorMsg}`);
        return null;
    }
}




// ─────────────────────────────────────────────
// 1. STANDARD VOLUME ENGINE
// ─────────────────────────────────────────────
async function executeStandardCycles(chatId, connection) {
    const usePool = STATE.useWalletPool && walletPool.size > 0;
    const walletCount = usePool ? Math.min(STATE.walletsPerCycle, walletPool.size) : STATE.maxSimultaneousBuys;
    
    bot.sendMessage(chatId, `📈 *Standard Mode*\n${usePool ? `Using ${walletCount} pool wallets` : `Generating ${walletCount} ephemeral wallets`}...`, { parse_mode: 'Markdown' });

    const activeWallets = usePool ? walletPool.getRandomSubset(walletCount) : Array.from({ length: walletCount }, () => Keypair.generate());

    try {
        if (!usePool) {
            const fundNeeded = (STATE.maxBuyAmount * 1.5) + (0.005 * STATE.numberOfCycles);
            await fundWallets(connection, masterKeypair, activeWallets, fundNeeded, chatId);
        }

        for (let i = 0; i < STATE.numberOfCycles && STATE.running; i++) {
            const volMult = getVolumeMultiplier();
            bot.sendMessage(chatId, `🔄 *Standard | Cycle ${i + 1}/${STATE.numberOfCycles}* | Vol: \`${volMult.toFixed(2)}x\``, { parse_mode: "Markdown" });

            bot.sendMessage(chatId, `🛒 Buying SOL across ${activeWallets.length} wallets (per-wallet randomization)...`, { parse_mode: "Markdown" });

            await BatchSwapEngine.executeBatch(
                activeWallets,
                async (w) => {
                    const jitteredBuy = parseFloat((getRandomFloat(STATE.minBuyAmount, STATE.maxBuyAmount) * volMult).toFixed(4));
                    return await swap(SOL_ADDR, STATE.tokenAddress, w, connection, jitteredBuy, chatId, true);
                },
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
    } finally {
        if (!usePool) {
            await drainWallets(connection, activeWallets, masterKeypair.publicKey, chatId);
        }
    }
}

// ─────────────────────────────────────────────
// 2. MULTI-WALLET MAKER ENGINE
// ─────────────────────────────────────────────
async function executeMakerCycles(chatId, connection) {
    const usePool = STATE.useWalletPool && walletPool.size > 0;
    const walletCount = usePool ? Math.min(STATE.walletsPerCycle, walletPool.size) : STATE.makerWalletsToGenerate;
    
    bot.sendMessage(chatId, `📈 *Advanced Maker Mode*\n${usePool ? `Using ${walletCount} pool wallets (of ${walletPool.size})` : `Generating ${walletCount} ephemeral wallets`}...`, { parse_mode: 'Markdown' });

    // Get wallets: pool or ephemeral
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
        // Fund wallets if not using pre-funded pool
        if (!usePool) {
            const fundAmount = parseFloat(getRandomFloat(STATE.minBuyAmount, STATE.maxBuyAmount).toFixed(4)) + 0.01;
            await fundWallets(connection, masterKeypair, childWallets.map(w => w.keypair), fundAmount, chatId);
        }

        bot.sendMessage(chatId, `✅ ${usePool ? 'Pool wallets selected' : 'Funding complete'}. Starting personality-driven trading with ${childWallets.length} wallets...`);

        // Personality-Driven Trading with batch concurrency
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
                            // Non-robotic: Humanized "thinking" delay before acting
                            const thinkTime = getRandomFloat(w.personality.minThink, w.personality.maxThink);
                            await sleep(thinkTime);

                            const sellAmt = Math.random() < 0.7 ? 'auto' : (balance * getRandomFloat(0.3, 0.7)).toFixed(6);
                            return swap(STATE.tokenAddress, SOL_ADDR, w.keypair, connection, sellAmt, chatId, true);
                        } else {
                            w.holdCyclesRemaining--;
                        }
                    } else {
                        if (roll < w.personality.buyProb) {
                            // Non-robotic: Humanized "thinking" delay before acting
                            const thinkTime = getRandomFloat(w.personality.minThink, w.personality.maxThink);
                            await sleep(thinkTime);

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

        // Drain ephemeral wallets (skip for pool wallets — they persist)
        if (!usePool) {
            await drainWallets(connection, childWallets.map(w => w.keypair), masterKeypair.publicKey, chatId);
        }
        bot.sendMessage(chatId, `✅ Maker session complete (${childWallets.length} wallets used).`);

    } catch (err) {
        console.error("Maker Loop Error:", err.message);
        bot.sendMessage(chatId, `⚠️ Maker Error: ${err.message}`);
    }

}

// ─────────────────────────────────────────────
// 10. WEB OF ACTIVITY STRATEGY (NEW)
// ─────────────────────────────────────────────
async function executeWebOfActivity(chatId, connection) {
    const usePool = STATE.useWalletPool && walletPool.size > 0;
    const walletCount = usePool ? Math.min(STATE.walletsPerCycle, walletPool.size) : 5;
    bot.sendMessage(chatId, `🕸️ *Strategy: Web of Activity*\n${usePool ? `Using ${walletCount} pool wallets` : `Generating ${walletCount} ephemeral wallets`}...`, { parse_mode: 'Markdown' });
    
    const targets = usePool ? walletPool.getRandomSubset(walletCount) : Array.from({ length: walletCount }, () => Keypair.generate());
    
    // Web fund only if not using pool
    if (!usePool) {
        await fundWallets(connection, masterKeypair, targets, 0.05, chatId);
    }
    
    for (let i = 0; i < STATE.numberOfCycles && STATE.running; i++) {
        bot.sendMessage(chatId, `🕸️ Web Cycle ${i+1}/${STATE.numberOfCycles} | ${walletCount} wallets`);
        
        // Randomly pick wallets to act (scale with pool size)
        const activeCount = Math.min(Math.max(2, Math.floor(walletCount * 0.3)), walletCount);
        const activeWallets = targets.sort(() => Math.random() - 0.5).slice(0, activeCount);
        
        await BatchSwapEngine.executeBatch(
            activeWallets,
            async (w) => {
                const balance = await getTokenBalance(connection, w.publicKey, STATE.tokenAddress);
                if (balance > 0 && Math.random() < 0.6) {
                    return swap(STATE.tokenAddress, SOL_ADDR, w, connection, 'auto', chatId, true);
                } else {
                    // Non-robotic: Randomize amount per-wallet
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
    
    // Drain only ephemeral wallets
    if (!usePool) {
        for (const w of targets) {
            const bal = await connection.getBalance(w.publicKey);
            if (bal > 10000) await sendSOL(connection, w, masterKeypair.publicKey, (bal - 10000) / LAMPORTS_PER_SOL);
        }
    }
    bot.sendMessage(chatId, `✅ Web of Activity complete (${walletCount} wallets).`);
}

// ─────────────────────────────────────────────
// 3. MICRO-SPAM TX BOOSTER
// ─────────────────────────────────────────────
async function executeSpamMode(chatId, connection) {
    const usePool = STATE.useWalletPool && walletPool.size > 0;
    const walletCount = usePool ? Math.min(STATE.walletsPerCycle, walletPool.size) : Math.max(5, STATE.walletsPerCycle);
    bot.sendMessage(chatId, `🔥 *Micro-Spam Mode*\nSpamming ${STATE.numberOfCycles} cycles of micro-buys (\`${STATE.spamMicroBuyAmount}\` SOL) across ${usePool ? `${walletCount} pool wallets` : `${walletCount} ephemeral wallets`}...`, { parse_mode: 'Markdown' });

    const activeWallets = usePool ? walletPool.getRandomSubset(walletCount) : Array.from({ length: walletCount }, () => Keypair.generate());

    try {
        if (!usePool) {
            const fundAmt = (STATE.spamMicroBuyAmount * STATE.numberOfCycles) + 0.02;
            await fundWallets(connection, masterKeypair, activeWallets, fundAmt, chatId);
        }

        let globalSuccessCount = 0;
        for (let i = 0; i < STATE.numberOfCycles && STATE.running; i++) {
            bot.sendMessage(chatId, `⚡ Spam Cycle ${i + 1}/${STATE.numberOfCycles}...`);
            
            const { successes } = await BatchSwapEngine.executeBatch(
                activeWallets,
                async (w) => {
                    // Non-robotic: Vary spam amount slightly per-wallet
                    const jitteredSpam = parseFloat((STATE.spamMicroBuyAmount * (0.8 + Math.random() * 0.4)).toFixed(6));
                    return await swap(SOL_ADDR, STATE.tokenAddress, w, connection, jitteredSpam, chatId, true);
                },
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
    } finally {
        if (!usePool) {
            await drainWallets(connection, activeWallets, masterKeypair.publicKey, chatId);
        }
    }
}

// ─────────────────────────────────────────────
// 5. CHART PATTERN ENGINEERING
// ─────────────────────────────────────────────
// Shapes price action by controlling buy/sell sizes per cycle
async function executeChartPattern(chatId, connection) {
    const pattern = STATE.chartPattern;
    const n = STATE.numberOfCycles;
    const usePool = STATE.useWalletPool && walletPool.size > 0;
    const walletCount = usePool ? Math.min(STATE.walletsPerCycle, walletPool.size) : Math.max(2, STATE.walletsPerCycle);
    
    bot.sendMessage(chatId, `📐 *Chart Pattern: ${pattern}*\nRunning ${n} cycles across ${usePool ? `${walletCount} pool wallets` : `${walletCount} ephemeral wallets`}...`, { parse_mode: 'Markdown' });

    const activeWallets = usePool ? walletPool.getRandomSubset(walletCount) : Array.from({ length: walletCount }, () => Keypair.generate());

    try {
        if (!usePool) {
            // Predict max funding per wallet needed across all cycles + gas bounds
            const fundNeeded = (STATE.maxBuyAmount * 1.5 * n) + (0.01 * n);
            await fundWallets(connection, masterKeypair, activeWallets, fundNeeded, chatId);
        }

        for (let i = 0; i < n && STATE.running; i++) {
            let buyMult, sellFrac;
            const progress = i / Math.max(n - 1, 1); // 0..1

            if (pattern === 'ASCENDING') {
                buyMult = 0.5 + progress;       // buys grow, sells shrink → uptrend
                sellFrac = 0.3 + (1 - progress) * 0.4;
            } else if (pattern === 'DESCENDING') {
                buyMult = 1.5 - progress;       // buys shrink, sells grow → downtrend
                sellFrac = 0.3 + progress * 0.6;
            } else if (pattern === 'SIDEWAYS') {
                buyMult = 0.9 + Math.sin(progress * Math.PI * 4) * 0.2;
                sellFrac = 0.85;
            } else if (pattern === 'CUP_HANDLE') {
                // U-shape: dip then recover, small handle dip at end
                const cup = Math.sin(progress * Math.PI);          // 0→1→0
                const handle = progress > 0.8 ? 0.3 * Math.sin((progress - 0.8) * Math.PI / 0.2) : 0;
                buyMult = 0.4 + cup * 0.8 - handle * 0.3;
                sellFrac = 0.5 + (1 - cup) * 0.4;
            } else { // BREAKOUT
                buyMult = progress < 0.7 ? 0.6 : 1.8; // flat then explosive
                sellFrac = progress < 0.7 ? 0.9 : 0.2;
            }

            bot.sendMessage(chatId, `📐 Cycle ${i + 1}/${n} [${pattern}] | Randomized Buy | SellFrac: \`${(sellFrac * 100).toFixed(0)}%\``, { parse_mode: 'Markdown' });

            await BatchSwapEngine.executeBatch(
                activeWallets,
                async (w) => {
                    const jitteredBuy = parseFloat((STATE.minBuyAmount + (STATE.maxBuyAmount - STATE.minBuyAmount) * buyMult * 0.7 * (0.85 + Math.random() * 0.3)).toFixed(4));
                    return await swap(SOL_ADDR, STATE.tokenAddress, w, connection, jitteredBuy, chatId, true);
                },
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
                    return null;
                },
                STATE.batchConcurrency,
                null,
                () => STATE.running
            );

            if (i < n - 1 && STATE.running)
                await sleep(getJitteredInterval(STATE.intervalBetweenActions, STATE.jitterPercentage));
        }
        bot.sendMessage(chatId, `✅ Chart pattern *${pattern}* complete.`, { parse_mode: 'Markdown' });
    } finally {
        if (!usePool) {
            await drainWallets(connection, activeWallets, masterKeypair.publicKey, chatId);
        }
    }
}

// ─────────────────────────────────────────────
// 6. HOLDER GROWTH SIMULATION
// ─────────────────────────────────────────────
// Generates N wallets that each buy and HOLD (no sell) to inflate holder count
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
                await sendSOL(connection, masterKeypair, w.publicKey, fundNeeded);
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
}

// ─────────────────────────────────────────────
// 7. WHALE SIMULATION
// ─────────────────────────────────────────────
async function executeWhaleSimulation(chatId, connection) {
    const buyAmt = STATE.whaleBuyAmount;
    const dumpPct = STATE.whaleSellPercent;
    const count = STATE.holderWallets;
    const usePool = STATE.useWalletPool && walletPool.size > 0;
    
    bot.sendMessage(chatId, `🐋 *Whale Simulation: ${count} whales*\nAccumulating ${buyAmt} SOL/whale then stealth dumping ${dumpPct}%...`, { parse_mode: 'Markdown' });

    const activeWhales = usePool ? walletPool.getRandomSubset(count) : Array.from({ length: Math.max(2, count) }, () => Keypair.generate());
    
    try {
        if (!usePool) {
            const fundNeeded = buyAmt + 0.05;
            await fundWallets(connection, masterKeypair, activeWhales, fundNeeded, chatId);
        }

        // Accumulate
        bot.sendMessage(chatId, `🐋 Whale accumulation...`);
        await BatchSwapEngine.executeBatch(
            activeWhales,
            async (w) => {
                await swap(SOL_ADDR, STATE.tokenAddress, w, connection, buyAmt, chatId, true);
                await sleep(getPoissonDelay(2000));
            },
            STATE.batchConcurrency,
            null,
            () => STATE.running
        );

        if (!STATE.running) return;

        bot.sendMessage(chatId, `🔴 Whale Cluster dumping ${STATE.whaleSellPercent}% of holdings in stealth chunks...`, { parse_mode: 'Markdown' });
        await BatchSwapEngine.executeBatch(
            activeWhales,
            async (w) => {
                const bal = await getTokenBalance(connection, w.publicKey, STATE.tokenAddress);
                if (bal > 0) {
                    const dumpChunks = Math.floor(getRandomFloat(2, 5));
                    const chunkPercent = (dumpPct / 100) / dumpChunks;
                    for (let c = 0; c < dumpChunks; c++) {
                        const dumpAmt = parseFloat((bal * chunkPercent).toFixed(6));
                        await swap(STATE.tokenAddress, SOL_ADDR, w, connection, dumpAmt, chatId, true);
                        await sleep(getJitteredInterval(800, 15));
                    }
                }
            },
            STATE.batchConcurrency,
            null,
            () => STATE.running
        );
    } finally {
        if (!usePool) {
            try {
                await drainWallets(connection, activeWhales, masterKeypair.publicKey, chatId);
            } catch (drainErr) {
                logger.error(`Drain failed in Whale strategy: ${drainErr.message}`);
            }
        }
    }
    bot.sendMessage(chatId, `🐋 Whale simulation complete.`);
}

// ─────────────────────────────────────────────
// 8. ADVANCED VOLUME BOOSTING
// ─────────────────────────────────────────────
// Spawns multiple wallets executing rapid concurrent buy/sell cycles
async function executeVolumeBoost(chatId, connection) {
    const usePool = STATE.useWalletPool && walletPool.size > 0;
    const walletCount = usePool ? Math.min(STATE.walletsPerCycle, walletPool.size) : STATE.volumeBoostMultiplier;
    const cycles = STATE.volumeBoostCycles;
    bot.sendMessage(chatId, `📊 *Volume Boost Mode*\n${usePool ? `Using ${walletCount} pool wallets` : `Spawning ${walletCount} ephemeral wallets`} × ${cycles} cycles...`, { parse_mode: 'Markdown' });

    const wallets = usePool ? walletPool.getRandomSubset(walletCount) : Array.from({ length: walletCount }, () => Keypair.generate());
    
    // Fund only ephemeral wallets
    if (!usePool) {
        const fundAmt = STATE.volumeBoostMaxAmount + 0.01;
        await fundWallets(connection, masterKeypair, wallets, fundAmt, chatId);
    }

    // Execute concurrent volume cycles
    for (let cycle = 0; cycle < cycles && STATE.running; cycle++) {
        bot.sendMessage(chatId, `🔄 Volume Cycle ${cycle + 1}/${cycles} | ${walletCount} wallets - Batch buys...`);

        // Batch buys
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

        // Batch sells
        bot.sendMessage(chatId, `📉 Batch sells (${walletCount} wallets)...`);
        await BatchSwapEngine.executeBatch(
            wallets,
            async (w) => {
                const bal = await getTokenBalance(connection, w.publicKey, STATE.tokenAddress);
                if (bal > 0) {
                    const dumpChunks = Math.floor(getRandomFloat(2, 4));
                    const chunkPercent = 1 / dumpChunks;
                    for (let c = 0; c < dumpChunks; c++) {
                        const dumpAmt = parseFloat((bal * chunkPercent).toFixed(6));
                        await swap(STATE.tokenAddress, SOL_ADDR, w, connection, dumpAmt, chatId, true);
                        await sleep(getJitteredInterval(500, 10));
                    }
                }
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

    // Drain only ephemeral wallets
    if (!usePool) {
        await drainWallets(connection, wallets, masterKeypair.publicKey, chatId);
    }
    bot.sendMessage(chatId, `✅ Volume Boost complete: ${walletCount} wallets × ${cycles} cycles.`);
}

// ─────────────────────────────────────────────
// 9. TRENDING STRATEGIES
// ─────────────────────────────────────────────
async function executeTrendingStrategy(chatId, connection) {
    const mode = STATE.trendingMode;
    const intensity = STATE.trendingIntensity;
    const usePool = STATE.useWalletPool && walletPool.size > 0;
    const baseCount = usePool ? Math.min(STATE.walletsPerCycle, walletPool.size) : 5;
    bot.sendMessage(chatId, `🔥 *Trending: ${mode}* (Intensity: ${intensity}/10)\nUsing multi-wallet arrays...`, { parse_mode: 'Markdown' });

    const activeWallets = usePool ? walletPool.getRandomSubset(baseCount) : Array.from({ length: baseCount }, () => Keypair.generate());

    try {
        if (!usePool) {
            // Rough fund based on worst case
            const fundNeeded = (STATE.maxBuyAmount * 3) + 0.05;
            await fundWallets(connection, masterKeypair, activeWallets, fundNeeded, chatId);
        }

        if (mode === 'VIRAL_PUMP') {
            const cycles = Math.floor(5 + intensity * 2);
            for (let i = 0; i < cycles && STATE.running; i++) {
                const freshWallets = usePool ? walletPool.getRandomSubset(baseCount) : activeWallets;
                const buyMult = Math.pow(1.3, i / cycles);
                const buyAmt = parseFloat((STATE.minBuyAmount * buyMult * intensity * 0.3).toFixed(4));
                bot.sendMessage(chatId, `🚀 Viral buy ${i + 1}/${cycles}: \`${buyAmt}\` SOL across wallets...`, { parse_mode: 'Markdown' });
                await BatchSwapEngine.executeBatch(
                    freshWallets,
                    async (w) => await swap(SOL_ADDR, STATE.tokenAddress, w, connection, buyAmt, chatId, true),
                    STATE.batchConcurrency, null, () => STATE.running
                );
                if (i % 2 === 0 && STATE.running) {
                    const sellWallets = usePool ? walletPool.getRandomSubset(baseCount) : activeWallets;
                    await BatchSwapEngine.executeBatch(
                        sellWallets,
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
                const randomWallets = [...activeWallets].sort(() => 0.5 - Math.random()).slice(0, Math.max(1, Math.floor(baseCount * 0.2)));
                bot.sendMessage(chatId, `🌱 Organic buy ${i + 1}/${cycles}: \`${buyAmt}\` SOL`, { parse_mode: 'Markdown' });
                await BatchSwapEngine.executeBatch(randomWallets, async (w) => await swap(SOL_ADDR, STATE.tokenAddress, w, connection, buyAmt, chatId, true), STATE.batchConcurrency, null, () => STATE.running);
                const pause = getJitteredInterval(5000 + intensity * 2000, 50);
                await sleep(pause);
                if (Math.random() < 0.2 && STATE.running) {
                    const sellWallets = [...randomWallets];
                    await BatchSwapEngine.executeBatch(sellWallets, async (w) => {
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
                    const surgeWallets = [...activeWallets].sort(() => 0.5 - Math.random()).slice(0, Math.max(1, Math.floor(baseCount * 0.4)));
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
                const ladders = [...activeWallets].sort(() => 0.5 - Math.random()).slice(0, Math.max(1, Math.floor(baseCount * 0.3)));
                bot.sendMessage(chatId, `🪜 Ladder step ${i + 1}/${steps}: \`${buyAmt}\` SOL`, { parse_mode: 'Markdown' });
                await BatchSwapEngine.executeBatch(ladders, async (w) => await swap(SOL_ADDR, STATE.tokenAddress, w, connection, buyAmt, chatId, true), STATE.batchConcurrency, null, () => STATE.running);
                await sleep(getJitteredInterval(STATE.intervalBetweenActions, STATE.jitterPercentage));
            }
        } else if (mode === 'WASH_TRADING') {
            const pairs = Math.floor(10 + intensity * 3);
            bot.sendMessage(chatId, `🔄 Wash Trading: ${pairs} pairs using distinct wallets...`);
            for (let i = 0; i < pairs && STATE.running; i++) {
                const amt = parseFloat(getRandomFloat(STATE.minBuyAmount * 0.5, STATE.maxBuyAmount * 0.7).toFixed(4));
                const washSubset = [...activeWallets].sort(() => Math.random() - 0.5);
                const half = Math.max(1, Math.floor(washSubset.length / 2));
                const buyers = washSubset.slice(0, half);
                const sellers = washSubset.slice(half);
                if (sellers.length === 0 && buyers.length > 1) {
                    sellers.push(buyers.pop());
                }

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
    } finally {
        if (!usePool) {
            await drainWallets(connection, activeWallets, masterKeypair.publicKey, chatId);
        }
    }
    
    bot.sendMessage(chatId, `🏁 Trending strategy *${mode}* complete!`, { parse_mode: 'Markdown' });
}

// ─────────────────────────────────────────────
// 4. PUMP & DUMP MODE
// ─────────────────────────────────────────────
async function executePumpDump(chatId, connection) {
    const usePool = STATE.useWalletPool && walletPool.size > 0;
    const walletCount = usePool ? Math.min(STATE.walletsPerCycle, walletPool.size) : Math.max(5, STATE.walletsPerCycle);
    
    bot.sendMessage(chatId, `🚀 *PUMP & DUMP MODE*\nAccumulating tokens across ${STATE.numberOfCycles} cycles using ${usePool ? `${walletCount} pool wallets` : `${walletCount} ephemeral wallets`}...`, { parse_mode: 'Markdown' });

    const activeWallets = usePool ? walletPool.getRandomSubset(walletCount) : Array.from({ length: walletCount }, () => Keypair.generate());

    try {
        if (!usePool) {
            const fundNeeded = (STATE.maxBuyAmount * 1.5 * STATE.numberOfCycles) + 0.05;
            await fundWallets(connection, masterKeypair, activeWallets, fundNeeded, chatId);
        }

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
    } finally {
        if (!usePool) {
            await drainWallets(connection, activeWallets, masterKeypair.publicKey, chatId);
        }
    }
}

// ─────────────────────────────────────────────
// 11. JITO MEV WASH STRATEGY (Risk-Free Volume)
// ─────────────────────────────────────────────
async function executeJitoMevWash(chatId, connection) {
    if (!STATE.useJito) {
        bot.sendMessage(chatId, `❌ Jito Protect must be ON to use MEV Wash!`, { parse_mode: 'Markdown' });
        return;
    }
    const cycles = STATE.numberOfCycles;
    const usePool = STATE.useWalletPool && walletPool.size > 0;
    bot.sendMessage(chatId, `🌪️ *JITO MEV WASH STRATEGY*\nExecuting bundled Buy & Sell simultaneously for ${cycles} cycles using ${usePool ? `pool wallets` : `ephemeral wallets`}...`, { parse_mode: 'Markdown' });

    const activeWallets = usePool ? walletPool.getRandomSubset(Math.min(5, walletPool.size)) : Array.from({ length: 5 }, () => Keypair.generate());

    try {
        if (!usePool) {
            const fundNeeded = STATE.maxBuyAmount + 0.05;
            await fundWallets(connection, masterKeypair, activeWallets, fundNeeded, chatId);
        }

        for (let i = 0; i < cycles && STATE.running; i++) {
            const amt = parseFloat(getRandomFloat(STATE.minBuyAmount, STATE.maxBuyAmount).toFixed(4));
            const activeWallet = activeWallets[Math.floor(Math.random() * activeWallets.length)];
            
            bot.sendMessage(chatId, `🌪️ Wash Bundle ${i + 1}/${cycles} [${activeWallet.publicKey.toBase58().substring(0,4)}...]: \`${amt}\` SOL`, { parse_mode: 'Markdown' });
            
            try {
                const solanaTracker = new SolanaTracker(activeWallet, RPC_URL);
                
                // 1. Get Buy TX
                const buyRes = await solanaTracker.getSwapInstructions(
                    SOL_ADDR, STATE.tokenAddress, amt, STATE.slippage, activeWallet.publicKey.toBase58(), 0, false
                );
                if (!buyRes || !buyRes.txn) throw new Error("Failed to get Buy instruction");

                // Sequential swap with Jito enabled (handled internally by swap function)
                const buyId = await swap(SOL_ADDR, STATE.tokenAddress, activeWallet, connection, amt, chatId, true);
                if (buyId) {
                    await sleep(1000); // Wait a bip for indexers
                    await swap(STATE.tokenAddress, SOL_ADDR, activeWallet, connection, 'auto', chatId, true);
                }
            } catch (err) {
                bot.sendMessage(chatId, `⚠️ Wash Error: ${err.message}`);
            }
            await sleep(getJitteredInterval(STATE.intervalBetweenActions, STATE.jitterPercentage));
        }
    } finally {
        if (!usePool) {
             await drainWallets(connection, activeWallets, masterKeypair.publicKey, chatId);
        }
    }
    bot.sendMessage(chatId, `✅ JITO MEV Wash Complete.`);
}


// ─────────────────────────────────────────────
// 12. KOL ALPHA CALL SIMULATION
// ─────────────────────────────────────────────
async function executeKolAlphaCall(chatId, connection) {
    const usePool = STATE.useWalletPool && walletPool.size > 0;
    const swarmSize = Math.min(STATE.kolRetailSwarmSize, usePool ? walletPool.size : 20);
    bot.sendMessage(chatId, `📱 *KOL ALPHA CALL SIMULATION*\nDeploying 1 Whale buy + ${swarmSize} Retail follower buys...`, { parse_mode: 'Markdown' });

    // 1. Whale Buy
    const whaleAmt = parseFloat((STATE.maxBuyAmount * 3).toFixed(4));
    bot.sendMessage(chatId, `🐋 KOL Whale calling with massive buy of \`${whaleAmt}\` SOL...`);
    await swap(SOL_ADDR, STATE.tokenAddress, masterKeypair, connection, whaleAmt, chatId, true);

    await sleep(2000);

    // 2. Retail Swarm from pool or ephemeral
    const swarmWallets = usePool ? walletPool.getRandomSubset(swarmSize) : Array.from({ length: swarmSize }, () => Keypair.generate());
    
    if (!usePool) {
        bot.sendMessage(chatId, `🐟 Retail swarm entering: Funding ${swarmWallets.length} wallets...`);
        for (const w of swarmWallets) {
            if (!STATE.running) break;
            await sendSOL(connection, masterKeypair, w.publicKey, STATE.minBuyAmount + 0.005);
            await sleep(500);
        }
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
}

// ─────────────────────────────────────────────
// 13. BULL TRAP MANIPULATION
// ─────────────────────────────────────────────
async function executeBullTrap(chatId, connection) {
    const usePool = STATE.useWalletPool && walletPool.size > 0;
    const trapWallets = usePool ? walletPool.getRandomSubset(3) : Array.from({ length: 3 }, () => Keypair.generate());

    bot.sendMessage(chatId, `🐻 *BULL TRAP MANIPULATION*\nFaking breakout then dumping at max slippage!`, { parse_mode: 'Markdown' });
    
    try {
        if (!usePool) {
            const fundNeeded = STATE.minBuyAmount * 2 + 0.05;
            await fundWallets(connection, masterKeypair, trapWallets, fundNeeded, chatId);
        }

        const steps = 5;
        
        // Fake Breakout
        for (let i = 0; i < steps && STATE.running; i++) {
            const amt = parseFloat((STATE.minBuyAmount * (1 + i * 0.5)).toFixed(4));
            bot.sendMessage(chatId, `📈 Bait Buy ${i+1}/${steps}: \`${amt}\` SOL`);
            await BatchSwapEngine.executeBatch(
                trapWallets,
                async (w) => await swap(SOL_ADDR, STATE.tokenAddress, w, connection, amt, chatId, true),
                STATE.batchConcurrency,
                null,
                () => STATE.running
            );
            await sleep(getJitteredInterval(1500, 10)); // rapid
        }
        
        bot.sendMessage(chatId, `⏳ Waiting 5s for MEV/Retail bots to bite...`);
        await sleep(getJitteredInterval(5000, 5));
        
        // Dump
        bot.sendMessage(chatId, `🔴 RUGGING TOKENS AT ${STATE.bullTrapSlippage || 20}% SLIPPAGE!`);
        const oldSlip = STATE.slippage;
        STATE.slippage = STATE.bullTrapSlippage || 20; 

        await BatchSwapEngine.executeBatch(
            trapWallets,
            async (w) => {
                const bal = await getTokenBalance(connection, w.publicKey, STATE.tokenAddress);
                if (bal > 0) {
                    return swap(STATE.tokenAddress, SOL_ADDR, w, connection, 'auto', chatId, false);
                }
            },
            STATE.batchConcurrency,
            null,
            () => STATE.running
        );
        STATE.slippage = oldSlip;
    } finally {
        if (!usePool) {
            await drainWallets(connection, trapWallets, masterKeypair.publicKey, chatId);
        }
    }
    bot.sendMessage(chatId, `✅ Bull Trap Complete.`);
}

// ─────────────────────────────────────────────
// 14. SOCIAL PROOF AIRDROP (HOLDER SWARM)
// ─────────────────────────────────────────────
async function executeSocialProofAirdrop(chatId, connection) {
    const usePool = STATE.useWalletPool && walletPool.size > 0;
    const wCount = usePool ? Math.min(STATE.airdropWalletCount, walletPool.size) : Math.min(STATE.airdropWalletCount, 30);
    bot.sendMessage(chatId, `🕸️ *SOCIAL PROOF AIRDROP (HOLDER SWARM)*\n${usePool ? `Using ${wCount} pool wallets` : `Creating ${wCount} ephemeral wallets`}...`, { parse_mode: 'Markdown' });

    const swarmWallets = usePool ? walletPool.getRandomSubset(wCount) : Array.from({ length: wCount }, () => Keypair.generate());
    
    // Fund only ephemeral wallets
    if (!usePool) {
        const fundAmt = 0.015;
        bot.sendMessage(chatId, `💸 Funding ${wCount} wallets with \`${fundAmt}\` SOL each...`);
        await BatchSwapEngine.executeBatch(
            swarmWallets,
            async (w, i) => {
                await sendSOL(connection, masterKeypair, w.publicKey, fundAmt);
                if ((i + 1) % Math.max(1, Math.floor(wCount / 5)) === 0) bot.sendMessage(chatId, `💸 Funded ${i + 1}/${wCount}`);
            },
            STATE.batchConcurrency,
            null,
            () => STATE.running
        );
    }

    // Execute swarm buys
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
}

// ─────────────────────────────────────────────
// Master Engine
// ─────────────────────────────────────────────
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
            const addr = masterKeypair.publicKey.toBase58();
            const shortAddr = addr.substring(0,8) + "..." + addr.substring(addr.length-4);
            
            logger.info(`Checking balance for ${addr} on ${connection.rpcEndpoint}`);

            bot.sendMessage(chatId, 
                `💰 *MASTER WALLET STATUS*\n` +
                `📍 Address: \`${addr}\`\n` +
                `💎 Balance: \`${balance.toFixed(4)}\` SOL\n\n` +
                `🚀 *Launching ${STATE.strategy} Strategy*...\n` +
                `📈 Jito: \`${STATE.useJito ? 'ON' : 'OFF'}\` | Vol Curve: \`${STATE.useVolumeCurve ? 'ON' : 'OFF'}\`\n` +
                `🛡️ Stealth: \`${STATE.fundingStealthLevel === 2 ? 'Multi-hop' : 'Direct'}\``, 
                { parse_mode: 'Markdown' }
            );

            if (balance < 0.001) {
                bot.sendMessage(chatId, `⚠️ *Warning:* SOL balance is very low (\`${balance.toFixed(4)}\`). Transfers or swaps may fail.`, { parse_mode: 'Markdown' });
            }

            if (balance < STATE.minBuyAmount + STATE.priorityFee) {
                bot.sendMessage(chatId, `❌ *Insufficient SOL:* Need at least \`${(STATE.minBuyAmount + STATE.priorityFee).toFixed(4)}\` SOL.`, { parse_mode: 'Markdown' });
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

// ─────────────────────────────────────────────
// Telegram UI Menus
// ─────────────────────────────────────────────
function showMainMenu(chatId) {
    const statusIcon = STATE.running ? '🟢' : '🔴';
    const statusText = STATE.running ? 'RUNNING' : 'IDLE';
    
    bot.sendMessage(chatId,
        `╔═══════════════════════╗\n` +
        `║  🤖 *VOLUME BOT v2.0*  ║\n` +
        `╚═══════════════════════╝\n\n` +
        `⚡ *Status:* ${statusIcon} ${statusText}\n` +
        `🎯 *Strategy:* \`${STATE.strategy}\`\n` +
        `💼 *Wallet Pool:* \`${walletPool.size.toLocaleString()}\` wallets\n` +
        `🪙 *Token:* ${STATE.tokenAddress ? '✅ Set' : '❌ Not Set'}\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━`,
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: (STATE.running ? '🛑 EMERGENCY STOP' : '🚀 LAUNCH ENGINE'), callback_data: (STATE.running ? 'stop_cycles' : 'start_cycles') }],
                    [{ text: '📈 Strategies', callback_data: 'strategies' }, { text: '⚙️ Settings', callback_data: 'settings' }],
                    [{ text: '💼 Wallet Pool', callback_data: 'wallet_pool' }, { text: '📊 Dashboard', callback_data: 'status' }],
                    [{ text: '📜 My Wallet', callback_data: 'show_wallet' }, { text: '❓ Help', callback_data: 'help' }]
                ]
            }
        }
    );
}

function showStrategyMenu(chatId) {
    const s = STATE.strategy;
    bot.sendMessage(chatId,
        `📈 *STRATEGY SELECTION*\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `Current: *${s}*\n\n` +
        `Choose your trading strategy:`,
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: (s === 'STANDARD' ? '✅ ' : '') + '🌐 Standard', callback_data: 'strat_standard' }, { text: (s === 'MAKER' ? '✅ ' : '') + '📈 Maker', callback_data: 'strat_maker' }],
                    [{ text: (s === 'WEB_OF_ACTIVITY' ? '✅ ' : '') + '🕸️ Web Activity', callback_data: 'strat_web' }, { text: (s === 'SPAM' ? '✅ ' : '') + '⚡ Spam', callback_data: 'strat_spam' }],
                    [{ text: (s === 'PUMP_DUMP' ? '✅ ' : '') + '🚀 Pump & Dump', callback_data: 'strat_pumpdump' }, { text: (s === 'CHART_PATTERN' ? '✅ ' : '') + '📐 Chart Pattern', callback_data: 'strat_chart' }],
                    [{ text: (s === 'HOLDER_GROWTH' ? '✅ ' : '') + '👥 Holder Growth', callback_data: 'strat_holder' }, { text: (s === 'WHALE' ? '✅ ' : '') + '🐋 Whale', callback_data: 'strat_whale' }],
                    [{ text: (s === 'VOLUME_BOOST' ? '✅ ' : '') + '📊 Volume Boost', callback_data: 'strat_volume' }, { text: (s === 'TRENDING' ? '✅ ' : '') + '🔥 Trending', callback_data: 'strat_trending' }],
                    [{ text: (s === 'JITO_MEV_WASH' ? '✅ ' : '') + '🌪️ MEV Wash', callback_data: 'strat_mev_wash' }, { text: (s === 'KOL_ALPHA_CALL' ? '✅ ' : '') + '📱 KOL Call', callback_data: 'strat_kol' }],
                    [{ text: (s === 'BULL_TRAP' ? '✅ ' : '') + '🐻 Bull Trap', callback_data: 'strat_bull' }, { text: (s === 'SOCIAL_PROOF_AIRDROP' ? '✅ ' : '') + '🎁 Airdrop', callback_data: 'strat_airdrop' }],
                    [{ text: '« Back', callback_data: 'back_to_main' }]
                ]
            }
        }
    );
}

function showSettingsMenu(chatId) {
    bot.sendMessage(chatId,
        `⚙️ *CONFIGURATION*\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `Select configuration category:`,
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '📱 Basic', callback_data: 'settings_basic' }, { text: '⚡ Advanced', callback_data: 'settings_advanced' }],
                    [{ text: '🎯 Strategy', callback_data: 'settings_strat' }, { text: '🎭 Realism', callback_data: 'show_realism' }],
                    [{ text: '🔌 Provider', callback_data: 'provider_settings' }, { text: '🛡️ Jito', callback_data: 'settings_jito' }],
                    [{ text: '« Back', callback_data: 'back_to_main' }]
                ]
            }
        }
    );
}

function showBasicSettings(chatId) {
    const tokenStatus = STATE.tokenAddress ? `\`${STATE.tokenAddress.substring(0,8)}...${STATE.tokenAddress.substring(STATE.tokenAddress.length-4)}\`` : '❌ Not Set';
    
    bot.sendMessage(chatId,
        `📱 *BASIC CONFIG*\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `🪙 *Token:* ${tokenStatus}\n` +
        `💰 *Buy Range:* \`${STATE.minBuyAmount}\` - \`${STATE.maxBuyAmount}\` SOL\n` +
        `🔁 *Cycles:* \`${STATE.numberOfCycles}\`\n` +
        `⏱ *Delay:* \`${STATE.intervalBetweenActions / 1000}s\`\n` +
        `🎲 *Jitter:* \`${STATE.jitterPercentage}%\``,
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🪙 Token Address', callback_data: 'set_token_address' }],
                    [{ text: '💰 Min Buy', callback_data: 'set_min_buy' }, { text: '💰 Max Buy', callback_data: 'set_max_buy' }],
                    [{ text: '🔁 Cycles', callback_data: 'set_cycles' }, { text: '🎲 Jitter', callback_data: 'set_jitter' }],
                    [{ text: '⏱ Delay', callback_data: 'set_interval' }],
                    [{ text: '« Back', callback_data: 'settings' }]
                ]
            }
        }
    );
}

function showAdvancedSettings(chatId) {
    bot.sendMessage(chatId,
        `⚡ *Advanced Engine Settings*\n\n` +
        `• Priority Fee: \`${STATE.priorityFee}\` SOL\n` +
        `• Slippage: \`${STATE.slippage}%\`\n` +
        `• Batch Concurrency: \`${STATE.batchConcurrency}\`\n` +
        `• Wallets/Cycle: \`${STATE.walletsPerCycle}\` (Pool Mode)\n` +
        `• Max Sync Buys/Sells: \`${STATE.maxSimultaneousBuys}/${STATE.maxSimultaneousSells}\``,
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '💸 Priority Fee', callback_data: 'set_fees' }, { text: '📉 Slippage', callback_data: 'set_slippage' }],
                    [{ text: '⚡ Concurrency', callback_data: 'set_batch_concurrency' }, { text: '👥 Wallets/Cycle', callback_data: 'set_wallets_per_cycle' }],
                    [{ text: '🔄 Buy/Sell Sync', callback_data: 'set_sync' }],
                    [{ text: '🔙 Back', callback_data: 'settings' }]
                ]
            }
        }
    );
}

function showStrategyConfigMenu(chatId) {
    bot.sendMessage(chatId,
        `🎯 *Strategy-Specific Tuning*\nFine-tune requirements for deep strategies:`,
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '📈 Maker Config', callback_data: 'conf_maker' }, { text: '⚡ Spam Config', callback_data: 'conf_spam' }],
                    [{ text: '🐋 Whale/Holder', callback_data: 'conf_whale' }, { text: '📐 Chart Pattern', callback_data: 'set_chart_pattern' }],
                    [{ text: '🔥 Trending', callback_data: 'conf_trending' }, { text: '🕸️ Social/Manip', callback_data: 'conf_manip' }],
                    [{ text: '🔙 Back', callback_data: 'settings' }]
                ]
            }
        }
    );
}

function showMakerConfig(chatId) {
    bot.sendMessage(chatId,
        `📈 *Maker Strategy Config*\n\n` +
        `• Wallets to Generate: \`${STATE.makerWalletsToGenerate}\` (Non-Pool)\n` +
        `• Funding Depth: \`${STATE.makerFundingChainDepth}\` hops`,
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '👥 Wallets to Gen', callback_data: 'set_maker_wallets' }],
                    [{ text: '🔗 Funding Depth', callback_data: 'set_maker_depth' }],
                    [{ text: '🔙 Back', callback_data: 'settings_strat' }]
                ]
            }
        }
    );
}

function showWhaleHolderConfig(chatId) {
    bot.sendMessage(chatId,
        `🐋 *Whale & Holder Simulation*\n\n` +
        `• Holder Wallets: \`${STATE.holderWallets}\`\n` +
        `• Holder Buy: \`${STATE.holderBuyAmount}\` SOL\n` +
        `• Whale Buy: \`${STATE.whaleBuyAmount}\` SOL\n` +
        `• Whale Dump: \`${STATE.whaleSellPercent}%\``,
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '👥 Holder Wallets', callback_data: 'set_holder_wallets' }, { text: '💵 Holder Buy', callback_data: 'set_holder_buy' }],
                    [{ text: '🐋 Whale Buy', callback_data: 'set_whale_buy' }, { text: '🔴 Whale Dump %', callback_data: 'set_whale_dump' }],
                    [{ text: '🔙 Back', callback_data: 'settings_strat' }]
                ]
            }
        }
    );
}

function showTrendingConfig(chatId) {
    bot.sendMessage(chatId,
        `🔥 *Trending Engine Config*\n\n` +
        `• Mode: *${STATE.trendingMode}*\n` +
        `• Intensity: \`${STATE.trendingIntensity}/10\``,
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🔥 Mode', callback_data: 'set_trending_mode' }, { text: '⚡ Intensity', callback_data: 'set_trending_intensity' }],
                    [{ text: '🔙 Back', callback_data: 'settings_strat' }]
                ]
            }
        }
    );
}

function showManipConfig(chatId) {
    bot.sendMessage(chatId,
        `🕸️ *Manipulation Strategy Config*\n\n` +
        `• KOL Swarm Size: \`${STATE.kolRetailSwarmSize}\`\n` +
        `• Airdrop Count: \`${STATE.airdropWalletCount}\`\n` +
        `• Bull Trap Slip: \`${STATE.bullTrapSlippage}%\``,
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🧪 KOL Swarm', callback_data: 'set_kol_swarm' }],
                    [{ text: '🕸️ Airdrop Count', callback_data: 'set_airdrop_count' }],
                    [{ text: '🐻 Bull Trap Slip', callback_data: 'set_bull_trap_slip' }],
                    [{ text: '🔙 Back', callback_data: 'settings_strat' }]
                ]
            }
        }
    );
}

function showJitoSettings(chatId) {
    bot.sendMessage(chatId,
        `🛡️ *Jito MEV Protection*\n\n` +
        `• Status: *${STATE.useJito ? '🟢 ENABLED (Private)' : '🔴 DISABLED (Public)'}*\n` +
        `• Tip Amount: \`${STATE.jitoTipAmount}\` SOL`,
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: `Toggle Jito ${STATE.useJito ? '🔴' : '🟢'}`, callback_data: 'set_jito' }],
                    [{ text: '💵 Set Jito Tip', callback_data: 'set_jito_tip' }],
                    [{ text: '🔙 Back', callback_data: 'settings' }]
                ]
            }
        }
    );
}

function showWalletPoolMenu(chatId) {
    const stats = walletPool.getStats();
    const modeIcon = STATE.useWalletPool ? '🟢' : '🔴';
    const modeText = STATE.useWalletPool ? 'ENABLED' : 'DISABLED';
    
    bot.sendMessage(chatId,
        `💼 *WALLET POOL*\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `📊 *Total Wallets:* \`${stats.total.toLocaleString()}\`\n` +
        `${modeIcon} *Status:* ${modeText}\n` +
        `⚡ *Concurrency:* \`${STATE.batchConcurrency}\`\n` +
        `👥 *Wallets/Cycle:* \`${STATE.walletsPerCycle}\`\n` +
        `💵 *Fund Amount:* \`${STATE.fundAmountPerWallet}\` SOL\n\n` +
        (stats.total > 0 ? `Sample: \`${stats.firstFew[0]?.substring(0,8)}...\`` : `⚠️ No wallets yet`),
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🔨 Generate', callback_data: 'pool_generate' }],
                    [{ text: '💰 Fund All', callback_data: 'pool_fund' }, { text: '🔄 Drain All', callback_data: 'pool_drain' }],
                    [{ text: '📊 Scan', callback_data: 'pool_scan' }, { text: `${STATE.useWalletPool ? '🔴 Disable' : '🟢 Enable'}`, callback_data: 'pool_toggle' }],
                    [{ text: '⚡ Concurrency', callback_data: 'set_batch_concurrency' }, { text: '👥 Per Cycle', callback_data: 'set_wallets_per_cycle' }],
                    [{ text: '💵 Fund Amt', callback_data: 'set_fund_amount' }, { text: '🗑️ Clear', callback_data: 'pool_clear' }],
                    [{ text: '« Back', callback_data: 'back_to_main' }]
                ]
            }
        }
    );
}

function showProviderMenu(chatId) {
    const p = STATE.swapProvider;
    bot.sendMessage(chatId,
        `🔌 *Select Swap Provider*\nCurrent: *${p}*\nTarget DEX: \`${STATE.targetDex}\``,
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: (p === 'SOLANA_TRACKER' ? '✅ ' : '') + '🌐 SolanaTracker (Aggregator)', callback_data: 'prov_tracker' }],
                    [{ text: (p === 'SOLANA_TRADE' ? '✅ ' : '') + '🎯 SolanaTrade (Targeted DEX)', callback_data: 'prov_trade' }],
                    [{ text: '🎯 Select Target DEX', callback_data: 'select_dex' }],
                    [{ text: '🔙 Back', callback_data: 'settings' }]
                ]
            }
        }
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
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
    });
}

function showRealismMenu(chatId) {
    bot.sendMessage(chatId,
        `🎭 *Advanced Realism & Stealth Engine*\n\n` +
        `• Engine Status: ${STATE.realismMode ? '🟢 ON' : '🔴 OFF'}\n` +
        `• Humanized Delays: ${STATE.humanizedDelays ? '🟢 ON' : '🔴 OFF'}\n` +
        `• Poisson Timing: ${STATE.usePoissonTiming ? '🟢 ON' : '🔴 OFF'}\n` +
        `• Variable Slippage: ${STATE.variableSlippage ? '🟢 ON' : '🔴 OFF'}\n` +
        `• Volume Curve: ${STATE.useVolumeCurve ? '🟢 ON' : '🔴 OFF'}\n` +
        `• Web Funding (Anti-Trace): ${STATE.useWebFunding ? '🟢 ON' : '🔴 OFF'}`,
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: `Toggle Engine ${STATE.realismMode ? '🔴' : '🟢'}`, callback_data: 'toggle_realism' }],
                    [{ text: `Human Delays ${STATE.humanizedDelays ? '🔴' : '🟢'}`, callback_data: 'toggle_delays' }],
                    [{ text: `Poisson Timing ${STATE.usePoissonTiming ? '🔴' : '🟢'}`, callback_data: 'toggle_poisson' }],
                    [{ text: `Variable Slip ${STATE.variableSlippage ? '🔴' : '🟢'}`, callback_data: 'toggle_varslip' }],
                    [{ text: `Volume Curve ${STATE.useVolumeCurve ? '🔴' : '🟢'}`, callback_data: 'toggle_vol_curve' }],
                    [{ text: '🛡️ Stealth Settings', callback_data: 'stealth_settings' }],
                    [{ text: '🔙 Back', callback_data: 'settings' }]
                ]
            }
        }
    );
}

function showStealthSettings(chatId) {
    const level = STATE.fundingStealthLevel;
    bot.sendMessage(chatId,
        `🛡️ *Stealth & Funding Architecture*\n\n` +
        `• Web Funding: ${STATE.useWebFunding ? '🟢 ENABLED' : '🔴 DISABLED'}\n` +
        `• Stealth Level: *Level ${level}* (${level === 2 ? 'Multi-hop' : 'Direct'})\n` +
        `• Maker Depth: \`${STATE.makerFundingChainDepth}\` hops\n` +
        `• Maker Wallets: \`${STATE.makerWalletsToGenerate}\``,
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: `Web Funding ${STATE.useWebFunding ? '🔴' : '🟢'}`, callback_data: 'toggle_web_funding' }],
                    [{ text: `Stealth Level: ${level === 2 ? 'Level 2' : 'Level 1'}`, callback_data: 'toggle_stealth_level' }],
                    [{ text: '🔗 Set Chain Depth', callback_data: 'set_maker_depth' }],
                    [{ text: '👥 Maker Wallets', callback_data: 'set_maker_wallets' }],
                    [{ text: '🔙 Back', callback_data: 'show_realism' }]
                ]
            }
        }
    );
}

function showSpamConfig(chatId) {
    bot.sendMessage(chatId,
        `⚡ *Micro-Spam TX Booster*\n\n` +
        `• Spam Amount: \`${STATE.spamMicroBuyAmount}\` SOL\n` +
        `• Success Rate Jitter: \`${STATE.jitterPercentage}%\``,
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '💵 Set Spam Amount', callback_data: 'set_spam_amount' }],
                    [{ text: '🎲 Set Jitter', callback_data: 'set_jitter' }],
                    [{ text: '🔙 Back', callback_data: 'settings_strat' }]
                ]
            }
        }
    );
}

function showHelp(chatId) {
    const helpMsg = 
        `❓ *Volume Bot Help & Guide*\n\n` +
        `*Core Strategies:*\n` +
        `• *Standard:* Smooth buy/sell cycles to maintain volume.\n` +
        `• *Maker:* Uses fresh non-pool wallets with multi-hop funding.\n` +
        `• *Spam:* Rapid micro-transactions to boost transaction count.\n` +
        `• *Whale:* Massive buys followed by stealthy chunked dumping.\n\n` +
        `*Engine Settings:*\n` +
        `• *Realism:* Adds human-like delays and variable slippage.\n` +
        `• *Wallet Pool:* Store up to 10k wallets for massive concurrent operations.\n` +
        `• *Jito:* Private transaction bundles to avoid MEV frontrunning.`;

    bot.sendMessage(chatId, helpMsg, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [[{ text: '« Back', callback_data: 'back_to_main' }]]
        }
    });
}


// ─────────────────────────────────────────────
// Telegram Callback Handler (ALL buttons)
// ─────────────────────────────────────────────
bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const action = callbackQuery.data;

    if (!isAdmin(chatId)) return bot.answerCallbackQuery(callbackQuery.id, { text: "⛔ Unauthorized.", show_alert: true });
    bot.answerCallbackQuery(callbackQuery.id);

    if (isRateLimited(chatId)) return;

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
    else if (action === 'conf_maker') showMakerConfig(chatId);
    else if (action === 'conf_whale') showWhaleHolderConfig(chatId);
    else if (action === 'conf_trending') showTrendingConfig(chatId);
    else if (action === 'conf_manip') showManipConfig(chatId);
    else if (action === 'back_to_main') showMainMenu(chatId);
    else if (action === 'provider_settings') showProviderMenu(chatId);
    else if (action === 'select_dex') showDexMenu(chatId);
    else if (action === 'show_realism') showRealismMenu(chatId);
    else if (action === 'wallet_pool') showWalletPoolMenu(chatId);
    else if (action === 'stealth_settings') showStealthSettings(chatId);
    else if (action === 'conf_spam') showSpamConfig(chatId);
    else if (action === 'help') showHelp(chatId);

    // Wallet Pool
    else if (action === 'pool_generate') {
        promptSetting(chatId, `🔨 Enter number of wallets to generate (e.g. \`100\`, \`1000\`):`, async (val) => {
            const count = parseInt(val);
            if (isNaN(count) || count <= 0) return bot.sendMessage(chatId, `❌ Invalid number.`);
            bot.sendMessage(chatId, `⏳ Generating ${count.toLocaleString()} wallets...`);
            const generated = await walletPool.generateWallets(count);
            bot.sendMessage(chatId, `✅ Generated *${generated.toLocaleString()}* wallets!\nTotal pool: *${walletPool.size.toLocaleString()}* wallets.`, { parse_mode: 'Markdown' });
            showWalletPoolMenu(chatId);
        });
    }
    else if (action === 'pool_fund') {
        if (walletPool.size === 0) return bot.sendMessage(chatId, `❌ No wallets in pool.`);
        if (!masterKeypair) return bot.sendMessage(chatId, `❌ No master wallet.`);
        const estCost = (walletPool.size * STATE.fundAmountPerWallet).toFixed(2);
        promptSetting(chatId, `💰 *Fund Wallet Pool*\n\nPool: \`${walletPool.size.toLocaleString()}\` wallets\nAmount: \`${STATE.fundAmountPerWallet}\` SOL each\n*Est. Cost: \`${estCost}\` SOL*\n\nReply \`YES\` to confirm:`, async (val) => {
            if (val.toUpperCase() !== 'YES') return bot.sendMessage(chatId, `❌ Cancelled.`);
            await withRpcFallback(async (connection) => {
                const targets = walletPool.wallets;
                if (STATE.useWebFunding && STATE.fundingStealthLevel === 2) {
                    bot.sendMessage(chatId, `🕸️ Stealth funding ${targets.length} wallets (multi-hop)...`);
                    await fundWeb(connection, masterKeypair, targets, STATE.fundAmountPerWallet, chatId);
                } else {
                    bot.sendMessage(chatId, `💰 Direct funding ${targets.length} wallets (parallel)...`);
                    await walletPool.fundAll(
                        connection, masterKeypair, sendSOL, STATE.fundAmountPerWallet, STATE.batchConcurrency,
                        (p) => {
                            if (p.completed % Math.max(1, Math.floor(p.total / 10)) === 0 || p.completed === p.total) {
                                bot.sendMessage(chatId, `💰 Progress: ${p.completed}/${p.total} | ✅ ${p.successes}${p.skipped ? ` | ⏭️ ${p.skipped} skipped` : ''}`);
                            }
                        },
                        () => STATE.running
                    );
                }
                bot.sendMessage(chatId, `✅ Funding operation complete.`);
                showWalletPoolMenu(chatId);
            });
        });
    }
    else if (action === 'pool_drain') {
        if (walletPool.size === 0) return bot.sendMessage(chatId, `❌ No wallets in pool.`);
        if (!masterKeypair) return bot.sendMessage(chatId, `❌ No master wallet.`);
        promptSetting(chatId, `🔄 *Drain Wallet Pool*\n\nEmptying ${walletPool.size.toLocaleString()} wallets back to master wallet.\n\nReply \`YES\` to confirm:`, async (val) => {
            if (val.toUpperCase() !== 'YES') return bot.sendMessage(chatId, `❌ Cancelled.`);
            await withRpcFallback(async (connection) => {
                bot.sendMessage(chatId, `🔄 Draining ${walletPool.size.toLocaleString()} wallets...`);
                await walletPool.drainAll(connection, masterKeypair, sendSOL, STATE.batchConcurrency, (p) => {
                    if (p.completed % Math.max(1, Math.floor(p.total/5)) === 0) bot.sendMessage(chatId, `🔄 Progress: ${p.completed}/${p.total} | ✅ ${p.successes}`);
                });
                bot.sendMessage(chatId, `✅ Drain complete.`);
                showWalletPoolMenu(chatId);
            });
        });
    }
    else if (action === 'pool_scan') {
        if (walletPool.size === 0) return bot.sendMessage(chatId, `❌ No wallets.`);
        await withRpcFallback(async (connection) => {
            bot.sendMessage(chatId, `📊 Scanning ${walletPool.size.toLocaleString()} wallets...`);
            const scan = await walletPool.scanBalances(connection, STATE.batchConcurrency);
            bot.sendMessage(chatId, `📊 *Scan Results*\nTotal: \`${walletPool.size}\`\nFunded: \`${scan.funded}\`\nEmpty: \`${scan.empty}\`\nTotal SOL: \`${scan.totalSOL.toFixed(4)}\``, { parse_mode: 'Markdown' });
            showWalletPoolMenu(chatId);
        });
    }
    else if (action === 'pool_toggle') { STATE.useWalletPool = !STATE.useWalletPool; showWalletPoolMenu(chatId); }
    else if (action === 'pool_clear') { promptSetting(chatId, `⚠️ *DELETE ALL WALLETS?*\nType \`DELETE\` to confirm:`, (val) => { if (val === 'DELETE') { walletPool.clearAll(); bot.sendMessage(chatId, `🗑️ Pool cleared.`); showWalletPoolMenu(chatId); } }); }

    else if (action === 'set_fund_amount') {
        promptSetting(chatId, `Reply with *SOL per wallet* for pool funding (e.g. \`0.01\`):`, (val) => {
            STATE.fundAmountPerWallet = parseFloat(val);
            saveConfig();
            bot.sendMessage(chatId, `✅ Fund Amount: \`${STATE.fundAmountPerWallet}\` SOL/wallet`, { parse_mode: 'Markdown' });
            showWalletPoolMenu(chatId);
        });
    }
    else if (action === 'set_batch_concurrency') {
        promptSetting(chatId, `Reply with *Batch Concurrency* (max parallel TXs, e.g. \`10\`, \`20\`, \`50\`):`, (val) => {
            STATE.batchConcurrency = Math.max(1, Math.min(100, parseInt(val)));
            bot.sendMessage(chatId, `✅ Batch Concurrency: \`${STATE.batchConcurrency}\``, { parse_mode: 'Markdown' });
            showWalletPoolMenu(chatId);
        });
    }
    else if (action === 'set_wallets_per_cycle') {
        promptSetting(chatId, `Reply with *Wallets Per Cycle* (how many pool wallets per strategy cycle, e.g. \`10\`, \`50\`):`, (val) => {
            STATE.walletsPerCycle = Math.max(1, parseInt(val));
            bot.sendMessage(chatId, `✅ Wallets/Cycle: \`${STATE.walletsPerCycle}\``, { parse_mode: 'Markdown' });
            showWalletPoolMenu(chatId);
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
        saveConfig();
        bot.sendMessage(chatId, `✅ Strategy: *${STATE.strategy}*`, { parse_mode: 'Markdown' });
        showStrategyMenu(chatId);
    }
    // Provider & DEX
    else if (action === 'prov_tracker') {
        STATE.swapProvider = 'SOLANA_TRACKER';
        saveConfig();
        bot.sendMessage(chatId, `✅ Provider set to: *SolanaTracker*`, { parse_mode: 'Markdown' });
        showProviderMenu(chatId);
    }
    else if (action === 'prov_trade') {
        STATE.swapProvider = 'SOLANA_TRADE';
        saveConfig();
        bot.sendMessage(chatId, `✅ Provider set to: *SolanaTrade*`, { parse_mode: 'Markdown' });
        showProviderMenu(chatId);
    }
    else if (action.startsWith('dex_')) {
        STATE.targetDex = action.replace('dex_', '');
        saveConfig();
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
            saveConfig();
            bot.sendMessage(chatId, `✅ Token CA set to:\n\`${STATE.tokenAddress}\``, { parse_mode: "Markdown" });
            showBasicSettings(chatId);
        });
    }
    else if (action === 'toggle_realism') { STATE.realismMode = !STATE.realismMode; saveConfig(); showRealismMenu(chatId); }
    else if (action === 'toggle_delays') { STATE.humanizedDelays = !STATE.humanizedDelays; saveConfig(); showRealismMenu(chatId); }
    else if (action === 'toggle_varslip') { STATE.variableSlippage = !STATE.variableSlippage; saveConfig(); showRealismMenu(chatId); }
    else if (action === 'toggle_poisson') { STATE.usePoissonTiming = !STATE.usePoissonTiming; saveConfig(); showRealismMenu(chatId); }
    else if (action === 'toggle_vol_curve') { STATE.useVolumeCurve = !STATE.useVolumeCurve; saveConfig(); showRealismMenu(chatId); }
    else if (action === 'toggle_web_funding') { STATE.useWebFunding = !STATE.useWebFunding; saveConfig(); showStealthSettings(chatId); }
    else if (action === 'toggle_stealth_level') { STATE.fundingStealthLevel = STATE.fundingStealthLevel === 2 ? 1 : 2; saveConfig(); showStealthSettings(chatId); }
    else if (action === 'set_min_buy') {
        promptSetting(chatId, `Reply with *Min Buy Amount* in SOL (0.0005 - 10):`, (val) => {
            try { STATE.minBuyAmount = validateNumber(val, 0.0005, 10, "Min Buy"); saveConfig(); bot.sendMessage(chatId, `✅ Min Buy: \`${STATE.minBuyAmount}\` SOL`); } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showBasicSettings(chatId);
        });
    }
    else if (action === 'set_max_buy') {
        promptSetting(chatId, `Reply with *Max Buy Amount* in SOL (0.0005 - 10):`, (val) => {
            try { STATE.maxBuyAmount = validateNumber(val, 0.0005, 10, "Max Buy"); saveConfig(); bot.sendMessage(chatId, `✅ Max Buy: \`${STATE.maxBuyAmount}\` SOL`); } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showBasicSettings(chatId);
        });
    }
    else if (action === 'set_cycles') {
        promptSetting(chatId, `Reply with total *Action Cycles* (1 - 1000):`, (val) => {
            try { STATE.numberOfCycles = validateNumber(val, 1, 1000, "Cycles"); saveConfig(); bot.sendMessage(chatId, `✅ Cycles: \`${STATE.numberOfCycles}\``); } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showBasicSettings(chatId);
        });
    }
    else if (action === 'set_jito') { STATE.useJito = !STATE.useJito; saveConfig(); bot.sendMessage(chatId, `✅ Jito Protect: *${STATE.useJito ? 'ON' : 'OFF'}*`); showJitoSettings(chatId); }
    else if (action === 'set_jito_tip') {
        promptSetting(chatId, `Reply with *Jito Tip* in SOL (0.00001 - 0.1):`, (val) => {
            try { STATE.jitoTipAmount = validateNumber(val, 0.00001, 0.1, "Jito Tip"); saveConfig(); bot.sendMessage(chatId, `✅ Jito Tip: \`${STATE.jitoTipAmount}\` SOL`); } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showJitoSettings(chatId);
        });
    }
    else if (action === 'set_fees') {
        promptSetting(chatId, `Reply with *Priority Fee* in SOL (0 - 0.01):`, (val) => {
            try { STATE.priorityFee = validateNumber(val, 0, 0.01, "Priority Fee"); saveConfig(); bot.sendMessage(chatId, `✅ Fee: \`${STATE.priorityFee}\` SOL`); } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showAdvancedSettings(chatId);
        });
    }
    else if (action === 'set_slippage') {
        promptSetting(chatId, `Reply with *Slippage %* (0.5 - 50):`, (val) => {
            try { STATE.slippage = validateNumber(val, 0.5, 50, "Slippage"); saveConfig(); bot.sendMessage(chatId, `✅ Slippage: \`${STATE.slippage}%\``); } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showAdvancedSettings(chatId);
        });
    }
    else if (action === 'set_jitter') {
        promptSetting(chatId, `Reply with *Jitter %* (0 - 100):`, (val) => {
            try { STATE.jitterPercentage = validateNumber(val, 0, 100, "Jitter"); saveConfig(); bot.sendMessage(chatId, `✅ Jitter: \`${STATE.jitterPercentage}%\``); } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showBasicSettings(chatId);
        });
    }
    else if (action === 'set_interval') {
        promptSetting(chatId, `Reply with *Base Delay* in seconds (1 - 300):`, (val) => {
            try { const sec = validateNumber(val, 1, 300, "Delay"); STATE.intervalBetweenActions = sec * 1000; saveConfig(); bot.sendMessage(chatId, `✅ Delay: \`${sec}s\``); } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showBasicSettings(chatId);
        });
    }
    else if (action === 'set_maker_wallets') {
        promptSetting(chatId, `Reply with number of *Maker Wallets* to generate (1 - 100):`, (val) => {
            try { STATE.makerWalletsToGenerate = validateNumber(val, 1, 100, "Maker Wallets"); saveConfig(); bot.sendMessage(chatId, `✅ Maker Wallets: \`${STATE.makerWalletsToGenerate}\``); } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showMakerConfig(chatId);
        });
    }
    else if (action === 'set_maker_depth') {
        promptSetting(chatId, `Reply with *Funding Chain Depth* (1 - 5):`, (val) => {
            try { STATE.makerFundingChainDepth = validateNumber(val, 1, 5, "Funding Depth"); saveConfig(); bot.sendMessage(chatId, `✅ Funding Depth: \`${STATE.makerFundingChainDepth}\``); } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showStealthSettings(chatId);
        });
    }
    else if (action === 'set_sync') {
        promptSetting(chatId, `Reply with *Max Concurrent Buys & Sells* (e.g. \`2 2\`):`, (val) => {
            const parts = val.trim().split(/\s+/);
            if (parts.length >= 2) {
                STATE.maxSimultaneousBuys = parseInt(parts[0]);
                STATE.maxSimultaneousSells = parseInt(parts[1]);
                saveConfig();
                bot.sendMessage(chatId, `✅ Buys: \`${STATE.maxSimultaneousBuys}\` | Sells: \`${STATE.maxSimultaneousSells}\``);
            } else { bot.sendMessage(chatId, `❌ Invalid format. Use: \`2 2\``); }
            showAdvancedSettings(chatId);
        });
    }
    else if (action === 'set_spam_amount') {
        promptSetting(chatId, `Reply with *Micro-Spam Buy Amount* in SOL (0.00001 - 0.01):`, (val) => {
            try { STATE.spamMicroBuyAmount = validateNumber(val, 0.00001, 0.01, "Spam Amount"); saveConfig(); bot.sendMessage(chatId, `✅ Spam Amount: \`${STATE.spamMicroBuyAmount}\` SOL`); } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showSpamConfig(chatId);
        });
    }
    else if (action === 'set_chart_pattern') {
        const patterns = ['ASCENDING', 'DESCENDING', 'SIDEWAYS', 'CUP_HANDLE', 'BREAKOUT'];
        bot.sendMessage(chatId, `📐 *Select Chart Pattern*\nCurrent: *${STATE.chartPattern}*`, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: patterns.map(p => [{ text: (STATE.chartPattern === p ? '✅ ' : '') + p, callback_data: `cpat_${p}` }]).concat([[{ text: '🔙 Back', callback_data: 'settings' }]]) }
        });
    }
    else if (action.startsWith('cpat_')) { STATE.chartPattern = action.replace('cpat_', ''); saveConfig(); bot.sendMessage(chatId, `✅ Chart Pattern: *${STATE.chartPattern}*`); showSettingsMenu(chatId); }
    else if (action === 'set_holder_wallets') {
        promptSetting(chatId, `Reply with *number of holder wallets* (1 - 1000):`, (val) => {
            try { STATE.holderWallets = validateNumber(val, 1, 1000, "Holder Wallets"); saveConfig(); bot.sendMessage(chatId, `✅ Holder Wallets: \`${STATE.holderWallets}\``); } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showWhaleHolderConfig(chatId);
        });
    }
    else if (action === 'set_holder_buy') {
        promptSetting(chatId, `Reply with *SOL per holder wallet* (0.001 - 1):`, (val) => {
            try { STATE.holderBuyAmount = validateNumber(val, 0.001, 1, "Holder Buy"); saveConfig(); bot.sendMessage(chatId, `✅ Holder Buy: \`${STATE.holderBuyAmount}\` SOL`); } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showWhaleHolderConfig(chatId);
        });
    }
    else if (action === 'set_whale_buy') {
        promptSetting(chatId, `Reply with *Whale Buy Amount* in SOL (0.1 - 100):`, (val) => {
            try { STATE.whaleBuyAmount = validateNumber(val, 0.1, 100, "Whale Buy"); saveConfig(); bot.sendMessage(chatId, `✅ Whale Buy: \`${STATE.whaleBuyAmount}\` SOL`); } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showWhaleHolderConfig(chatId);
        });
    }
    else if (action === 'set_whale_dump') {
        promptSetting(chatId, `Reply with *Whale Dump %* (1 - 100):`, (val) => {
            try { STATE.whaleSellPercent = validateNumber(val, 1, 100, "Whale Dump %"); saveConfig(); bot.sendMessage(chatId, `✅ Whale Dump: \`${STATE.whaleSellPercent}%\``); } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showWhaleHolderConfig(chatId);
        });
    }
    else if (action === 'set_vol_mult') {
        promptSetting(chatId, `Reply with *Volume Boost Multiplier* (1 - 50):`, (val) => {
            try { STATE.volumeBoostMultiplier = validateNumber(val, 1, 50, "Volume Multiplier"); saveConfig(); bot.sendMessage(chatId, `✅ Volume Multiplier: \`${STATE.volumeBoostMultiplier}\` wallets`); } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showSettingsMenu(chatId);
        });
    }
    else if (action === 'set_vol_cycles') {
        promptSetting(chatId, `Reply with *Volume Boost Cycles* (1 - 100):`, (val) => {
            try { STATE.volumeBoostCycles = validateNumber(val, 1, 100, "Volume Cycles"); saveConfig(); bot.sendMessage(chatId, `✅ Volume Cycles: \`${STATE.volumeBoostCycles}\``); } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showSettingsMenu(chatId);
        });
    }
    else if (action === 'set_vol_range') {
        promptSetting(chatId, `Reply with *Volume Min Max* in SOL (e.g. \`0.005 0.02\`):`, (val) => {
            const parts = val.split(' ');
            if (parts.length >= 2) {
                STATE.volumeBoostMinAmount = parseFloat(parts[0]);
                STATE.volumeBoostMaxAmount = parseFloat(parts[1]);
                saveConfig();
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
    else if (action.startsWith('tmode_')) { STATE.trendingMode = action.replace('tmode_', ''); saveConfig(); bot.sendMessage(chatId, `✅ Trending Mode: *${STATE.trendingMode}*`); showSettingsMenu(chatId); }
    else if (action === 'set_trending_intensity') {
        promptSetting(chatId, `Reply with *Trending Intensity* (1-10):`, (val) => {
            try { STATE.trendingIntensity = validateNumber(val, 1, 10, "Trending Intensity"); saveConfig(); bot.sendMessage(chatId, `✅ Trending Intensity: \`${STATE.trendingIntensity}/10\``); } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showSettingsMenu(chatId);
        });
    }
    else if (action === 'set_kol_swarm') {
        promptSetting(chatId, `Reply with *KOL Retail Swarm Size* (1 - 500):`, (val) => {
            try { STATE.kolRetailSwarmSize = validateNumber(val, 1, 500, "KOL Swarm"); saveConfig(); bot.sendMessage(chatId, `✅ KOL Swarm: \`${STATE.kolRetailSwarmSize}\``); } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showManipConfig(chatId);
        });
    }
    else if (action === 'set_airdrop_count') {
        promptSetting(chatId, `Reply with *Airdrop Wallet Count* (1 - 1000):`, (val) => {
            try { STATE.airdropWalletCount = validateNumber(val, 1, 1000, "Airdrop Count"); saveConfig(); bot.sendMessage(chatId, `✅ Airdrop Count: \`${STATE.airdropWalletCount}\``); } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showManipConfig(chatId);
        });
    }
    else if (action === 'set_bull_trap_slip') {
        promptSetting(chatId, `Reply with *Bull Trap Dump Slippage %* (1 - 50):`, (val) => {
            try { STATE.bullTrapSlippage = validateNumber(val, 1, 50, "Bull Trap Slippage"); saveConfig(); bot.sendMessage(chatId, `✅ Bull Trap Slippage: \`${STATE.bullTrapSlippage}%\``); } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showManipConfig(chatId);
        });
    }
    // Dashboard
    else if (action === 'status') {
        if (!masterKeypair) return bot.sendMessage(chatId, `❌ No wallet loaded.`);
        try {
            await withRpcFallback(async (connection) => {
                const solBal = await connection.getBalance(masterKeypair.publicKey) / LAMPORTS_PER_SOL;
                let tokenBal = 0;
                if (STATE.tokenAddress) tokenBal = await getTokenBalance(connection, masterKeypair.publicKey, STATE.tokenAddress);
                const estTxs = Math.floor(solBal / (STATE.maxBuyAmount + STATE.priorityFee));
                bot.sendMessage(chatId,
                    `📊 *Bot Dashboard*\n\n💰 *Balances*\nSOL: \`${solBal.toFixed(4)}\`\nToken: \`${tokenBal}\`\n\n💼 *Wallet Pool*\nTotal: \`${walletPool.size.toLocaleString()}\` wallets | Mode: *${STATE.useWalletPool ? 'ON' : 'OFF'}*\nConcurrency: \`${STATE.batchConcurrency}\` | Wallets/Cycle: \`${STATE.walletsPerCycle}\`\n\n⚙️ *Config*\nStrategy: *${STATE.strategy}*\nProvider: *${STATE.swapProvider}*\nDEX: *${STATE.targetDex}*\nToken: \`${STATE.tokenAddress || 'Not Set'}\`\nBuy Range: \`${STATE.minBuyAmount} - ${STATE.maxBuyAmount}\` SOL\nFee: \`${STATE.priorityFee}\` | Slip: \`${STATE.slippage}%\`\nJitter: \`${STATE.jitterPercentage}%\` | Delay: \`${STATE.intervalBetweenActions / 1000}s\`\nCycles: \`${STATE.numberOfCycles}\` | Sync: \`${STATE.maxSimultaneousBuys}/${STATE.maxSimultaneousSells}\`\n\n🛡️ Engine: ${STATE.running ? '🟢 ONLINE' : '🔴 OFFLINE'}\n🔁 Est. Max Swaps: \`${estTxs}\``,
                    { parse_mode: 'Markdown' }
                );
            });
        } catch (e) { logger.error(`Dashboard error: ${e.message}`); bot.sendMessage(chatId, `⚠️ Could not fetch status: ${e.message}`); }
    }
    // Wallet
    else if (action === 'show_wallet') {
        if (!masterKeypair) return bot.sendMessage(chatId, `❌ No wallet loaded.`);
        const addr = masterKeypair.publicKey.toBase58();
        bot.sendMessage(chatId, `📜 *Master Wallet*\n\`${addr}\`\n\n[View on Solscan](https://solscan.io/account/${addr})`, { parse_mode: 'Markdown' });
    }
});

// ─────────────────────────────────────────────
// Bot Start
// ─────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
    if (isAdmin(msg.chat.id)) showMainMenu(msg.chat.id);
    else bot.sendMessage(msg.chat.id, "⛔ Unauthorized.");
});

loadConfig(); // Load persistent state
console.log("🔍 [BOOT] Reached end of initialization.");
console.log("🤖 Elite Volume Bot Engine is online.");
