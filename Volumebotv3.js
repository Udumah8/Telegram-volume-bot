import fs from "fs";
import 'dotenv/config';
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

// ─────────────────────────────────────────────
// 🔐 PRODUCTION HARDENING: Graceful Shutdown
// ─────────────────────────────────────────────
let isShuttingDown = false;
process.on('SIGINT', async () => { handleShutdown('SIGINT'); });
process.on('SIGTERM', async () => { handleShutdown('SIGTERM'); });
process.on('uncaughtException', async (err) => {
    logger.error(`Uncaught Exception: ${err.message}`);
    await handleShutdown('uncaughtException');
});
process.on('unhandledRejection', async (reason) => {
    logger.error(`Unhandled Rejection: ${reason}`);
    await handleShutdown('unhandledRejection');
});

async function handleShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info(`🛑 Shutdown signal received: ${signal}`);
    STATE.running = false;
    
    // Persist state before exit
    saveConfig();
    
    // Allow in-flight operations to complete (max 30s)
    await sleep(3000);
    
    logger.info('✅ Graceful shutdown complete');
    await logger.end();
    process.exit(0);
}

// ─────────────────────────────────────────────
// 📝 Logger Configuration
// ─────────────────────────────────────────────
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.printf(({ timestamp, level, message, stack }) => 
            `${timestamp} [${level.toUpperCase()}]: ${message}${stack ? '\n' + stack : ''}`)
    ),
    transports: [
        new winston.transports.File({ filename: 'bot.log', maxsize: 5242880, maxFiles: 5 }),
        new winston.transports.Console()
    ]
});

// ─────────────────────────────────────────────
// 🌐 RPC Fallback with Exponential Backoff (v1 resilience + v2 simplicity)
// ─────────────────────────────────────────────
const RPC_URLS = process.env.RPC_URLS 
    ? process.env.RPC_URLS.split(',').map(url => url.trim()) 
    : [process.env.RPC_URL || "https://api.mainnet-beta.solana.com"];

let currentRpcIndex = 0;

function getConnection() {
    const url = RPC_URLS[currentRpcIndex % RPC_URLS.length];
    return new Connection(url, { commitment: 'confirmed' });
}

async function withRpcFallback(fn, maxRetries = null) {
    const retries = maxRetries || RPC_URLS.length;
    let lastError;
    
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            const connection = getConnection();
            return await fn(connection);
        } catch (err) {
            lastError = err;
            logger.warn(`RPC ${RPC_URLS[currentRpcIndex % RPC_URLS.length]} failed (attempt ${attempt + 1}/${retries}): ${err.message}`);
            currentRpcIndex++;
            
            // Exponential backoff with jitter (v1 improvement)
            if (attempt < retries - 1) {
                const baseDelay = 1000 * Math.pow(2, attempt);
                const jitter = baseDelay * 0.1 * Math.random();
                const delay = Math.min(baseDelay + jitter, 5000);
                logger.info(`⏳ Retrying in ${Math.round(delay)}ms...`);
                await sleep(delay);
            }
        }
    }
    throw new Error(`All RPC endpoints failed. Last error: ${lastError?.message || 'Unknown'}`);
}

// ─────────────────────────────────────────────
// ⚙️ Configuration Management with Persistence (v1 feature restored)
// ─────────────────────────────────────────────
const CONFIG_FILE = 'config.json';
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

if (!TELEGRAM_TOKEN) {
    logger.error("❌ Missing TELEGRAM_TOKEN in .env");
    process.exit(1);
}

function saveConfig() {
    try {
        const sanitized = { ...STATE };
        // Don't persist runtime flags
        delete sanitized.running;
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(sanitized, null, 2));
        logger.debug('✅ Config saved to disk');
    } catch (e) {
        logger.error(`❌ Failed to save config: ${e.message}`);
    }
}

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
            // Merge saved config with defaults (new fields won't be lost)
            Object.assign(STATE, saved);
            logger.info(`✅ Configuration loaded from ${CONFIG_FILE}`);
        }
    } catch (e) {
        logger.error(`❌ Failed to load config: ${e.message}`);
    }
}

// ─────────────────────────────────────────────
// 🤖 Telegram Bot Setup
// ─────────────────────────────────────────────
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: { autoStart: true, interval: 300 } });

// Master wallet with enhanced error handling
let masterKeypair = null;
if (process.env.PRIVKEY) {
    try {
        if (process.env.PRIVKEY.trim().startsWith('[')) {
            masterKeypair = Keypair.fromSecretKey(Buffer.from(JSON.parse(process.env.PRIVKEY)));
        } else {
            masterKeypair = Keypair.fromSecretKey(bs58.decode(process.env.PRIVKEY.trim()));
        }
        const pubKey = masterKeypair.publicKey.toBase58();
        logger.info(`✅ Master Wallet loaded: ${pubKey.substring(0,8)}...${pubKey.substring(pubKey.length-4)}`);
    } catch (e) {
        logger.error(`❌ Failed to load master wallet: ${e.message}`);
        // Don't exit - allow read-only operations
    }
} else {
    logger.warn("⚠️ No PRIVKEY in .env — wallet operations disabled (read-only mode)");
}

// ─────────────────────────────────────────────
// 💼 Wallet Pool Initialization
// ─────────────────────────────────────────────
const SOL_ADDR = "So11111111111111111111111111111111111111112";
const walletPool = new WalletPool();
logger.info(`💼 Wallet Pool: ${walletPool.size.toLocaleString()} wallets loaded`);

// ─────────────────────────────────────────────
// 👥 User Session Management with Cleanup (v1 improvement restored)
// ─────────────────────────────────────────────
const userSessions = new Map(); // chatId -> { action, timeout, callback, created }

function clearSession(chatId) {
    const cid = chatId.toString();
    const session = userSessions.get(cid);
    if (session) {
        clearTimeout(session.timeout);
        userSessions.delete(cid);
        logger.debug(`🧹 Cleared session for chat ${cid}`);
    }
}

// Periodic cleanup of expired sessions (prevents memory leaks)
setInterval(() => {
    const now = Date.now();
    const expired = [];
    
    for (const [chatId, session] of userSessions.entries()) {
        if (now - session.created > 300000) { // 5 minutes
            expired.push(chatId);
        }
    }
    
    for (const cid of expired) {
        clearTimeout(userSessions.get(cid).timeout);
        userSessions.delete(cid);
        logger.debug(`🧹 Auto-cleaned expired session: ${cid}`);
    }
    
    if (expired.length > 0) {
        logger.info(`🧹 Cleaned ${expired.length} expired sessions`);
    }
}, 60000);

// Message handler for interactive prompts
bot.on('message', (msg) => {
    if (isShuttingDown) return;
    
    const chatId = msg.chat.id.toString();
    
    // Help users find their ID
    if (msg.text && /id|whoami/i.test(msg.text)) {
        logger.info(`🔍 User ID check: Chat ${chatId} (@${msg.from?.username || 'unknown'})`);
        bot.sendMessage(chatId, `📋 Your Chat ID: \`${chatId}\``, { parse_mode: 'Markdown' });
        return;
    }

    const session = userSessions.get(chatId);
    if (!session) return;
    
    // Commands break prompts
    if (msg.text && msg.text.startsWith('/')) {
        clearSession(chatId);
        return;
    }

    if (!msg.text) return; // Ignore non-text

    clearTimeout(session.timeout);
    userSessions.delete(chatId);
    
    try {
        session.callback(msg.text.trim());
    } catch (e) {
        logger.error(`❌ Prompt callback error: ${e.message}`);
        bot.sendMessage(chatId, `⚠️ Error processing input: ${e.message}`);
    }
});

// ─────────────────────────────────────────────
// 🎭 Constants & State (v2 structure + v1 defaults)
// ─────────────────────────────────────────────
const PERSONALITIES = {
    DIAMOND: { buyProb: 0.8, sellProb: 0.1, minHold: 5, maxHold: 15, sizeMult: 0.8, minThink: 2000, maxThink: 8000 },
    SCALPER: { buyProb: 0.9, sellProb: 0.8, minHold: 1, maxHold: 3, sizeMult: 1.2, minThink: 500, maxThink: 2500 },
    RETAIL:  { buyProb: 0.5, sellProb: 0.4, minHold: 2, maxHold: 6, sizeMult: 0.5, minThink: 1000, maxThink: 6000 },
    WHALE:   { buyProb: 0.3, sellProb: 0.05, minHold: 10, maxHold: 30, sizeMult: 3.0, minThink: 3000, maxThink: 20000 }
};

const STATE = {
    // Core
    tokenAddress: "",
    strategy: "STANDARD",
    running: false,
    
    // Volume Config
    minBuyAmount: 0.01,
    maxBuyAmount: 0.05,
    priorityFee: 0.0005,
    slippage: 2,
    numberOfCycles: 3,
    maxSimultaneousBuys: 1,
    maxSimultaneousSells: 1,
    intervalBetweenActions: 15000,
    jitterPercentage: 20,
    
    // Realism Engine (v2 safety)
    realismMode: true,
    humanizedDelays: true,
    variableSlippage: true,
    usePoissonTiming: true,
    useVolumeCurve: true,
    volCurveIntensity: 1.5,
    
    // Stealth & Funding
    useWalletPool: true,
    fundAmountPerWallet: 0.01,
    batchConcurrency: 10,
    walletsPerCycle: 50,
    useWebFunding: true,
    fundingStealthLevel: 2, // 1=direct, 2=multi-hop
    makerFundingChainDepth: 2,
    makerWalletsToGenerate: 3,
    
    // Jito MEV
    useJito: false,
    jitoTipAmount: 0.0001,
    
    // Strategy Specifics
    spamMicroBuyAmount: 0.0001,
    swapProvider: "SOLANA_TRACKER",
    targetDex: "RAYDIUM_AMM",
    chartPattern: "ASCENDING",
    
    // Simulation Params
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
    
    // Personality Mix
    personalityMix: ['RETAIL', 'SCALPER', 'DIAMOND'],
    
    // Pool Config
    walletPoolSize: 100
};

// Load persisted config at startup
loadConfig();

// ─────────────────────────────────────────────
// 🔍 Validation Helpers
// ─────────────────────────────────────────────
function validateNumber(val, min, max, name) {
    const num = parseFloat(val);
    if (isNaN(num)) throw new Error(`${name} must be a number`);
    if (num < min || num > max) throw new Error(`${name} must be between ${min} and ${max}`);
    return num;
}

function validateTokenAddress(address) {
    if (!address || typeof address !== 'string') {
        throw new Error('Token address is required');
    }
    // Basic length check for base58 Solana addresses
    if (address.length < 32 || address.length > 44) {
        throw new Error('Invalid token address length');
    }
    try {
        const decoded = bs58.decode(address);
        if (decoded.length !== 32) {
            throw new Error('Token address must be 32 bytes');
        }
    } catch (e) {
        throw new Error('Invalid token address format (base58)');
    }
    return address;
}

// ─────────────────────────────────────────────
// 🛡️ Utility Functions (v2 safety + v1 robustness)
// ─────────────────────────────────────────────
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
    
    // Humanized delays (v2 realism)
    if (STATE.realismMode && STATE.humanizedDelays) {
        if (Math.random() < 0.10) {
            const distraction = Math.floor(getRandomFloat(5000, 15000));
            logger.debug(`[Realism] Human distraction: +${distraction}ms`);
            interval += distraction;
        }
        if (Math.random() < 0.05) {
            const thinkTime = Math.floor(getRandomFloat(20000, 45000));
            logger.debug(`[Realism] Deep think: +${thinkTime}ms`);
            interval += thinkTime;
        }
    }
    return Math.max(100, interval); // Minimum 100ms
}

function getDynamicSlippage(baseSlippage) {
    if (!STATE.realismMode || !STATE.variableSlippage) return baseSlippage;
    const variance = (Math.random() * 2) - 1; // ±1%
    return Math.max(0.5, parseFloat((baseSlippage + variance).toFixed(1)));
}

function getDynamicFee(baseFee) {
    if (!STATE.realismMode) return baseFee;
    const variance = baseFee * ((Math.random() * 0.4) - 0.2); // ±20%
    return Math.max(0.00001, parseFloat((baseFee + variance).toFixed(6)));
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getPoissonDelay(mean) {
    if (!STATE.usePoissonTiming) return mean;
    // Exponential distribution for natural inter-arrival times
    return Math.floor(-mean * Math.log(Math.max(0.001, 1.0 - Math.random())));
}

function getVolumeMultiplier() {
    if (!STATE.useVolumeCurve) return 1.0;
    const now = new Date();
    const hours = now.getHours() + now.getMinutes() / 60;
    // 24-hour wave: low at 4am, peak at 4pm UTC
    const wave = Math.sin((hours - 10) * (Math.PI / 12));
    const multiplier = 1.0 + (wave * 0.5 * STATE.volCurveIntensity);
    const noise = (Math.random() * 0.4 - 0.2) * STATE.volCurveIntensity;
    return Math.max(0.1, Math.min(3.0, multiplier + noise)); // Clamp 0.1x - 3.0x
}

// ─────────────────────────────────────────────
// 🕸️ Stealth Funding: Multi-hop with Drain (v2 sequential safety)
// ─────────────────────────────────────────────
async function fundWebSafe(connection, from, targets, amountSOL, chatId) {
    const maxDepth = STATE.makerFundingChainDepth;
    const allIntermediates = [];
    let successCount = 0;

    bot.sendMessage(chatId, `🕸️ *Stealth Web Funding*\n📦 ${targets.length} wallets | Max depth: ${maxDepth} hops`, { parse_mode: 'Markdown' });

    for (let i = 0; i < targets.length && STATE.running && !isShuttingDown; i++) {
        const target = targets[i];
        const depth = Math.floor(getRandomFloat(1, maxDepth + 1));
        const path = [from];
        const intermediatesThisPath = [];

        // Build multi-hop path
        for (let d = 0; d < depth; d++) {
            const inter = Keypair.generate();
            path.push(inter);
            intermediatesThisPath.push(inter);
            allIntermediates.push(inter);
        }
        path.push(target);

        logger.debug(`[StealthFund] Path ${i+1}: ${depth} hops → ${target.publicKey.toBase58().slice(0,8)}...`);

        let currentAmount = amountSOL + (0.005 * depth); // Buffer for fees

        // Fund along the path sequentially (v2 safety)
        for (let j = 0; j < path.length - 1; j++) {
            if (!STATE.running || isShuttingDown) break;
            const sender = path[j];
            const receiver = path[j + 1];
            
            try {
                const txid = await sendSOL(connection, sender, receiver.publicKey, currentAmount);
                logger.info(`[StealthFund] Hop ${j+1}: ${sender.publicKey.toBase58().slice(0,4)} → ${receiver.publicKey.toBase58().slice(0,4)} | ${txid.slice(0,8)}...`);
                successCount++;
            } catch (err) {
                logger.error(`[StealthFund] Hop ${j} failed: ${err.message}`);
                if (chatId) bot.sendMessage(chatId, `⚠️ Funding break at hop ${j+1}: ${err.message}`).catch(() => {});
                break;
            }
            
            currentAmount -= 0.004; // Reduce for next hop (fee estimation)
            await sleep(getPoissonDelay(2000)); // Natural spacing
        }
        
        await sleep(getPoissonDelay(3000)); // Pause between targets
    }

    // Drain intermediates (cleanup)
    if (allIntermediates.length > 0 && STATE.running && !isShuttingDown) {
        bot.sendMessage(chatId, `🧹 Draining ${allIntermediates.length} intermediate wallets...`, { parse_mode: 'Markdown' });
        
        for (const inter of allIntermediates) {
            if (!STATE.running || isShuttingDown) break;
            try {
                const bal = await connection.getBalance(inter.publicKey);
                if (bal > 10000) { // Keep 0.00001 SOL for rent
                    await sendSOL(connection, inter, from.publicKey, (bal - 10000) / LAMPORTS_PER_SOL);
                    await sleep(500);
                }
            } catch (err) {
                logger.warn(`[Drain] Intermediate cleanup failed: ${err.message}`);
            }
        }
        bot.sendMessage(chatId, `✅ Intermediates drained.`, { parse_mode: 'Markdown' });
    }
    
    logger.info(`[StealthFund] Complete: ${successCount}/${targets.length * (maxDepth+1)} hops successful`);
    if (chatId) bot.sendMessage(chatId, `✅ Stealth funding complete.`, { parse_mode: 'Markdown' }).catch(() => {});
}

async function fundWalletsDirect(connection, from, targets, amountSOL, chatId) {
    let successCount = 0;
    
    bot.sendMessage(chatId, `💰 Direct funding ${targets.length} wallets @ \`${amountSOL}\` SOL each...`, { parse_mode: 'Markdown' });
    
    for (let i = 0; i < targets.length && STATE.running && !isShuttingDown; i++) {
        const target = targets[i];
        try {
            await sendSOL(connection, from, target.publicKey, amountSOL);
            successCount++;
            
            // Progress updates for large batches
            if ((i + 1) % 10 === 0 || i === targets.length - 1) {
                bot.sendMessage(chatId, `💰 Progress: ${i + 1}/${targets.length} funded`, { parse_mode: 'Markdown' }).catch(() => {});
            }
        } catch (err) {
            logger.error(`[DirectFund] Wallet ${i+1} failed: ${err.message}`);
            if (chatId) bot.sendMessage(chatId, `⚠️ Funding failed for wallet ${i+1}: ${err.message}`).catch(() => {});
        }
        await sleep(getPoissonDelay(1000)); // Natural spacing
    }
    
    logger.info(`[DirectFund] Complete: ${successCount}/${targets.length} successful`);
    if (chatId) bot.sendMessage(chatId, `✅ Direct funding complete: ${successCount}/${targets.length} succeeded.`, { parse_mode: 'Markdown' }).catch(() => {});
}

async function fundWallets(connection, from, targets, amountSOL, chatId) {
    if (STATE.useWebFunding && STATE.fundingStealthLevel === 2) {
        await fundWebSafe(connection, from, targets, amountSOL, chatId);
    } else {
        await fundWalletsDirect(connection, from, targets, amountSOL, chatId);
    }
}

// ─────────────────────────────────────────────
// 💸 SOL Transfer with Balance Check (v2 safety)
// ─────────────────────────────────────────────
async function sendSOL(connection, from, to, amountSOL) {
    // Pre-check balance (v2 safety improvement)
    const balance = await connection.getBalance(from.publicKey);
    const lamportsNeeded = Math.floor(amountSOL * LAMPORTS_PER_SOL) + 5000; // Buffer for fees
    
    if (balance < lamportsNeeded) {
        throw new Error(`Insufficient balance: ${balance / LAMPORTS_PER_SOL} SOL < ${amountSOL + 0.000005} SOL needed`);
    }

    const tx = new Transaction().add(
        SystemProgram.transfer({
            fromPubkey: from.publicKey,
            toPubkey: to,
            lamports: Math.floor(amountSOL * LAMPORTS_PER_SOL)
        })
    );

    if (STATE.useJito) {
        // Jito bundle path
        tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
        tx.feePayer = from.publicKey;
        tx.sign(from);
        const b58Tx = bs58.encode(tx.serialize());
        return await sendJitoBundle([b58Tx], from, connection, STATE.jitoTipAmount);
    } else {
        // Standard path
        tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        tx.feePayer = from.publicKey;
        tx.sign(from);
        const txid = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
        await connection.confirmTransaction(txid, 'finalized');
        return txid;
    }
}

// ─────────────────────────────────────────────
// 🪙 Token Balance Helper
// ─────────────────────────────────────────────
async function getTokenBalance(connection, owner, tokenAddr) {
    try {
        if (tokenAddr === SOL_ADDR) {
            return (await connection.getBalance(owner)) / LAMPORTS_PER_SOL;
        }
        const result = await connection.getTokenAccountsByOwner(owner, { mint: new PublicKey(tokenAddr) });
        if (result.value.length === 0) return 0;
        const info = await connection.getTokenAccountBalance(result.value[0].pubkey);
        return info.value.uiAmount || 0;
    } catch (error) {
        logger.debug(`[TokenBalance] Query failed: ${error.message}`);
        return 0;
    }
}

// ─────────────────────────────────────────────
// 🔄 Swap Function with Retries + Validation (v1 resilience + v2 safety)
// ─────────────────────────────────────────────
async function swap(tokenIn, tokenOut, keypair, connection, amount, chatId, silent = false) {
    const maxRetries = 3;
    let lastError;
    const shortKey = keypair.publicKey.toBase58().substring(0, 8);

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            // Parse amount (v2 safety)
            let cleanAmount;
            if (typeof amount === 'string' && amount === 'auto') {
                cleanAmount = 'auto';
            } else {
                cleanAmount = parseFloat(parseFloat(amount).toFixed(6));
                if (isNaN(cleanAmount) || cleanAmount <= 0) {
                    throw new Error(`Invalid amount: ${amount}`);
                }
            }

            // Pre-swap balance check for buys (v2 safety)
            const isBuy = tokenIn === SOL_ADDR;
            if (isBuy && cleanAmount !== 'auto') {
                const requiredSol = cleanAmount 
                    + (cleanAmount * STATE.slippage / 100) 
                    + STATE.priorityFee 
                    + (STATE.useJito ? STATE.jitoTipAmount : 0);
                const balance = await connection.getBalance(keypair.publicKey) / LAMPORTS_PER_SOL;
                
                if (balance < requiredSol) {
                    throw new Error(`Insufficient SOL: ${balance.toFixed(6)} < ${requiredSol.toFixed(6)} needed`);
                }
            }

            // Dynamic parameters (v2 realism)
            const currentSlippage = getDynamicSlippage(STATE.slippage);
            const currentFee = getDynamicFee(STATE.priorityFee);

            if (STATE.swapProvider === "SOLANA_TRADE") {
                if (!SolanaTrade) throw new Error("SolanaTrade provider not loaded");
                
                const trade = new SolanaTrade(RPC_URLS[0]);
                const params = {
                    market: STATE.targetDex,
                    wallet: keypair,
                    mint: isBuy ? tokenOut : tokenIn,
                    amount: cleanAmount === 'auto' 
                        ? (await getTokenBalance(connection, keypair.publicKey, isBuy ? tokenOut : tokenIn))
                        : cleanAmount,
                    slippage: currentSlippage,
                    priorityFeeSol: STATE.useJito ? 0 : currentFee,
                    tipAmountSol: STATE.useJito ? STATE.jitoTipAmount : 0,
                    sender: STATE.useJito ? 'JITO' : undefined,
                    skipConfirmation: STATE.useJito,
                    send: true
                };
                
                if (!silent && attempt === 0) {
                    bot.sendMessage(chatId, `⚡ ${STATE.targetDex} ${isBuy ? '🟢 Buy' : '🔴 Sell'}...`, { parse_mode: 'Markdown' }).catch(() => {});
                }
                
                const sig = isBuy ? await trade.buy(params) : await trade.sell(params);
                if (!silent && sig) {
                    bot.sendMessage(chatId, `✅ [Tx](https://solscan.io/tx/${sig})`, { parse_mode: 'Markdown' }).catch(() => {});
                }
                return sig;
                
            } else {
                // SolanaTracker provider
                const solanaTracker = new SolanaTracker(keypair, RPC_URLS[0]);
                const swapResponse = await solanaTracker.getSwapInstructions(
                    tokenIn, tokenOut, cleanAmount, currentSlippage, 
                    keypair.publicKey.toBase58(), 
                    STATE.useJito ? 0 : currentFee, 
                    false
                );

                if (!swapResponse || (!swapResponse.txn && !swapResponse.tx)) {
                    throw new Error('No transaction returned from swap API');
                }

                let txid;
                if (STATE.useJito) {
                    const serializedTx = swapResponse.txn || swapResponse.tx;
                    const b58Tx = typeof serializedTx === 'string' 
                        ? serializedTx 
                        : bs58.encode(Buffer.from(serializedTx, 'base64'));
                    txid = await sendJitoBundle([b58Tx], keypair, connection, STATE.jitoTipAmount);
                } else {
                    txid = await solanaTracker.performSwap(swapResponse, {
                        sendOptions: { skipPreflight: false },
                        commitment: "finalized",
                    });
                }

                if (!silent && txid) {
                    bot.sendMessage(chatId, `✅ [Tx](https://solscan.io/tx/${txid})`, { parse_mode: 'Markdown' }).catch(() => {});
                }
                return txid;
            }
            
        } catch (e) {
            lastError = e;
            const errorMsg = e.message || "Unknown error";
            logger.warn(`[Swap] ${shortKey} attempt ${attempt + 1}/${maxRetries}: ${errorMsg}`);
            
            // Retry logic with backoff (v1 resilience)
            if (attempt < maxRetries - 1) {
                const delay = Math.min(1000 * Math.pow(2, attempt), 3000);
                await sleep(delay);
                continue;
            }
        }
    }
    
    // All retries failed
    logger.error(`[Swap] ${shortKey} failed after ${maxRetries} attempts: ${lastError?.message || "Unknown"}`);
    if (!silent && chatId) {
        bot.sendMessage(chatId, `⚠️ Swap failed [${shortKey}...]: ${lastError?.message || "Unknown error"}`).catch(() => {});
    }
    return null;
}

// ─────────────────────────────────────────────
// 🧹 Drain Wallets Helper
// ─────────────────────────────────────────────
async function drainWallets(connection, wallets, masterPubkey, chatId) {
    if (!wallets?.length) return;
    
    let successCount = 0;
    bot.sendMessage(chatId, `🧹 Draining ${wallets.length} wallets...`, { parse_mode: 'Markdown' }).catch(() => {});
    
    for (const w of wallets) {
        if (!STATE.running || isShuttingDown) break;
        try {
            const bal = await connection.getBalance(w.publicKey);
            if (bal > 10000) { // Keep minimum for rent
                await sendSOL(connection, w, masterPubkey, (bal - 10000) / LAMPORTS_PER_SOL);
                successCount++;
                await sleep(500); // Space out drains
            }
        } catch (err) {
            logger.warn(`[Drain] Wallet ${w.publicKey.toBase58().slice(0,8)} failed: ${err.message}`);
        }
    }
    
    logger.info(`[Drain] Complete: ${successCount}/${wallets.length} drained`);
    if (chatId) bot.sendMessage(chatId, `✅ Drain complete: ${successCount}/${wallets.length} succeeded.`, { parse_mode: 'Markdown' }).catch(() => {});
}

// ─────────────────────────────────────────────
// 📈 Strategy: Standard Cycles (v2 cleaner implementation)
// ─────────────────────────────────────────────
async function executeStandardCycles(chatId, connection) {
    const usePool = STATE.useWalletPool && walletPool.size > 0;
    const walletCount = usePool ? Math.min(STATE.walletsPerCycle, walletPool.size) : 1;
    
    bot.sendMessage(chatId, `📈 *Standard Mode*\n${usePool ? `Using ${walletCount} pool wallets` : `Using master wallet`}...`, { parse_mode: 'Markdown' });

    for (let i = 0; i < STATE.numberOfCycles && STATE.running && !isShuttingDown; i++) {
        const volMult = getVolumeMultiplier();
        const cycleMsg = await bot.sendMessage(chatId, 
            `🔄 *Cycle ${i + 1}/${STATE.numberOfCycles}* | Vol: \`${volMult.toFixed(2)}x\``, 
            { parse_mode: "Markdown" }
        );

        const activeWallets = usePool ? walletPool.getRandomSubset(walletCount) : [masterKeypair];

        // Batch buy phase
        const buyResult = await BatchSwapEngine.executeBatch(
            activeWallets,
            async (w) => {
                const jitteredBuy = parseFloat((getRandomFloat(STATE.minBuyAmount, STATE.maxBuyAmount) * volMult).toFixed(4));
                return await swap(SOL_ADDR, STATE.tokenAddress, w, connection, jitteredBuy, chatId, true);
            },
            STATE.batchConcurrency,
            (progress) => {
                // Real-time progress updates
                if (progress.completed % 5 === 0 || progress.completed === progress.total) {
                    bot.editMessageText(
                        `🔄 *Cycle ${i + 1}/${STATE.numberOfCycles}*\n🛒 Buying: ${progress.completed}/${progress.total} | ✅ ${progress.successes} | ❌ ${progress.failures}`,
                        { chat_id: chatId, message_id: cycleMsg.message_id, parse_mode: "Markdown" }
                    ).catch(() => {});
                }
            },
            () => STATE.running && !isShuttingDown
        );

        if (!STATE.running || isShuttingDown) break;
        await sleep(getPoissonDelay(STATE.intervalBetweenActions));

        // Batch sell phase
        await BatchSwapEngine.executeBatch(
            activeWallets,
            async (w) => {
                const bal = await getTokenBalance(connection, w.publicKey, STATE.tokenAddress);
                if (bal > 0) return swap(STATE.tokenAddress, SOL_ADDR, w, connection, 'auto', chatId, true);
                return null;
            },
            STATE.batchConcurrency,
            (progress) => {
                if (progress.completed % 5 === 0 || progress.completed === progress.total) {
                    bot.editMessageText(
                        `🔄 *Cycle ${i + 1}/${STATE.numberOfCycles}*\n📉 Selling: ${progress.completed}/${progress.total} | ✅ ${progress.successes} | ❌ ${progress.failures}`,
                        { chat_id: chatId, message_id: cycleMsg.message_id, parse_mode: "Markdown" }
                    ).catch(() => {});
                }
            },
            () => STATE.running && !isShuttingDown
        );

        // Inter-cycle delay
        if (i < STATE.numberOfCycles - 1 && STATE.running && !isShuttingDown) {
            const wait = getPoissonDelay(STATE.intervalBetweenActions * 2);
            bot.sendMessage(chatId, `⏳ Cycle ${i+1} done. Rest: \`${Math.round(wait / 1000)}s\`...`, { parse_mode: "Markdown" });
            await sleep(wait);
        }
    }
}

// ─────────────────────────────────────────────
// 📈 Strategy: Maker Cycles (v2 personality-driven)
// ─────────────────────────────────────────────
async function executeMakerCycles(chatId, connection) {
    const usePool = STATE.useWalletPool && walletPool.size > 0;
    const walletCount = usePool ? Math.min(STATE.walletsPerCycle, walletPool.size) : STATE.makerWalletsToGenerate;
    
    bot.sendMessage(chatId, `📈 *Maker Mode*\n${usePool ? `Using ${walletCount} pool wallets` : `Generating ${walletCount} ephemeral`}...`, { parse_mode: 'Markdown' });

    // Initialize wallets with personalities
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
        // Fund ephemeral wallets only
        if (!usePool) {
            const fundAmount = parseFloat(getRandomFloat(STATE.minBuyAmount, STATE.maxBuyAmount).toFixed(4)) + 0.01;
            await fundWallets(connection, masterKeypair, childWallets.map(w => w.keypair), fundAmount, chatId);
        }

        bot.sendMessage(chatId, `✅ ${usePool ? 'Pool ready' : 'Funding complete'}. Starting personality-driven trading...`);

        // Personality-driven trading loop
        for (let cycle = 0; cycle < STATE.numberOfCycles && STATE.running && !isShuttingDown; cycle++) {
            const volMult = getVolumeMultiplier();
            bot.sendMessage(chatId, `🔄 *Maker Cycle ${cycle + 1}/${STATE.numberOfCycles}* | ${childWallets.length} wallets | Vol: \`${volMult.toFixed(2)}x\``, { parse_mode: 'Markdown' });

            await BatchSwapEngine.executeBatch(
                childWallets,
                async (w) => {
                    if (!STATE.running || isShuttingDown) return;
                    
                    const balance = await getTokenBalance(connection, w.keypair.publicKey, STATE.tokenAddress);
                    const roll = Math.random();
                    
                    if (balance > 0) {
                        // SELL LOGIC
                        if (w.holdCyclesRemaining <= 0 && roll < w.personality.sellProb) {
                            // Humanized "thinking" delay (v2 realism)
                            const thinkTime = getRandomFloat(w.personality.minThink, w.personality.maxThink);
                            await sleep(thinkTime);

                            const sellAmt = Math.random() < 0.7 ? 'auto' : (balance * getRandomFloat(0.3, 0.7)).toFixed(6);
                            return swap(STATE.tokenAddress, SOL_ADDR, w.keypair, connection, sellAmt, chatId, true);
                        } else {
                            w.holdCyclesRemaining--;
                        }
                    } else {
                        // BUY LOGIC
                        if (roll < w.personality.buyProb) {
                            // Humanized "thinking" delay
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
                        bot.sendMessage(chatId, `✅ Cycle ${cycle + 1}: ${p.successes} trades, ${p.failures} failed`);
                    }
                },
                () => STATE.running && !isShuttingDown
            );
            
            const waitTime = getPoissonDelay(STATE.intervalBetweenActions);
            bot.sendMessage(chatId, `⏳ Natural pause: \`${Math.round(waitTime / 1000)}s\`...`, { parse_mode: 'Markdown' });
            await sleep(waitTime);
        }

        // Drain ephemeral wallets only (pool wallets persist)
        if (!usePool) {
            bot.sendMessage(chatId, `🧹 Draining ephemeral wallets...`);
            await drainWallets(connection, childWallets.map(w => w.keypair), masterKeypair.publicKey, chatId);
        }
        
        bot.sendMessage(chatId, `✅ Maker session complete (${childWallets.length} wallets).`);

    } catch (err) {
        logger.error(`[Maker] Error: ${err.message}`);
        bot.sendMessage(chatId, `⚠️ Maker Error: ${err.message}`).catch(() => {});
    }
}

// ─────────────────────────────────────────────
// 🕸️ Strategy: Web of Activity (v2 implementation)
// ─────────────────────────────────────────────
async function executeWebOfActivity(chatId, connection) {
    const usePool = STATE.useWalletPool && walletPool.size > 0;
    const walletCount = usePool ? Math.min(STATE.walletsPerCycle, walletPool.size) : 5;
    
    bot.sendMessage(chatId, `🕸️ *Web of Activity*\n${usePool ? `Using ${walletCount} pool wallets` : `Generating ${walletCount} ephemeral`}...`, { parse_mode: 'Markdown' });
    
    const targets = usePool ? walletPool.getRandomSubset(walletCount) : Array.from({ length: walletCount }, () => Keypair.generate());
    
    if (!usePool) {
        await fundWallets(connection, masterKeypair, targets, 0.05, chatId);
    }
    
    for (let i = 0; i < STATE.numberOfCycles && STATE.running && !isShuttingDown; i++) {
        bot.sendMessage(chatId, `🕸️ Web Cycle ${i+1}/${STATE.numberOfCycles} | ${walletCount} wallets`, { parse_mode: 'Markdown' });
        
        const activeCount = Math.min(Math.max(2, Math.floor(walletCount * 0.3)), walletCount);
        const activeWallets = [...targets].sort(() => Math.random() - 0.5).slice(0, activeCount);
        
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
            () => STATE.running && !isShuttingDown
        );
        
        await sleep(getPoissonDelay(STATE.intervalBetweenActions));
    }
    
    if (!usePool) {
        await drainWallets(connection, targets, masterKeypair.publicKey, chatId);
    }
    bot.sendMessage(chatId, `✅ Web of Activity complete.`, { parse_mode: 'Markdown' });
}

// ─────────────────────────────────────────────
// ⚡ Strategy: Spam Mode (v2 implementation)
// ─────────────────────────────────────────────
async function executeSpamMode(chatId, connection) {
    const usePool = STATE.useWalletPool && walletPool.size > 0;
    const walletCount = usePool ? Math.min(STATE.walletsPerCycle, walletPool.size) : 5;
    
    bot.sendMessage(chatId, `🔥 *Micro-Spam Mode*\n${STATE.numberOfCycles} cycles × ${walletCount} wallets @ \`${STATE.spamMicroBuyAmount}\` SOL`, { parse_mode: 'Markdown' });

    let globalSuccessCount = 0;
    
    for (let i = 0; i < STATE.numberOfCycles && STATE.running && !isShuttingDown; i++) {
        const activeWallets = usePool ? walletPool.getRandomSubset(walletCount) : [masterKeypair];
        bot.sendMessage(chatId, `⚡ Spam Cycle ${i + 1}/${STATE.numberOfCycles}...`, { parse_mode: 'Markdown' });
        
        const { successes } = await BatchSwapEngine.executeBatch(
            activeWallets,
            async (w) => {
                const jitteredSpam = parseFloat((STATE.spamMicroBuyAmount * (0.8 + Math.random() * 0.4)).toFixed(6));
                return await swap(SOL_ADDR, STATE.tokenAddress, w, connection, jitteredSpam, chatId, true);
            },
            STATE.batchConcurrency,
            null,
            () => STATE.running && !isShuttingDown
        );
        
        globalSuccessCount += successes;
        await sleep(getJitteredInterval(1500, STATE.jitterPercentage));
    }

    bot.sendMessage(chatId, `📊 Spam complete: ${globalSuccessCount} transactions confirmed.`, { parse_mode: 'Markdown' });

    // Dump accumulated tokens
    bot.sendMessage(chatId, `📉 Dumping accumulated tokens...`, { parse_mode: 'Markdown' });
    const dumpWallets = usePool ? walletPool.getRandomSubset(walletCount) : [masterKeypair];
    
    await BatchSwapEngine.executeBatch(
        dumpWallets,
        async (w) => {
            const bal = await getTokenBalance(connection, w.publicKey, STATE.tokenAddress);
            if (bal > 0) return swap(STATE.tokenAddress, SOL_ADDR, w, connection, 'auto', chatId, true);
            return null;
        },
        STATE.batchConcurrency,
        null,
        () => STATE.running && !isShuttingDown
    );
}

// ─────────────────────────────────────────────
// 📐 Strategy: Chart Pattern (v2 implementation)
// ─────────────────────────────────────────────
async function executeChartPattern(chatId, connection) {
    const pattern = STATE.chartPattern;
    const n = STATE.numberOfCycles;
    const usePool = STATE.useWalletPool && walletPool.size > 0;
    const walletCount = usePool ? Math.min(STATE.walletsPerCycle, walletPool.size) : 5;
    
    bot.sendMessage(chatId, `📐 *Chart Pattern: ${pattern}*\n${n} cycles × ${walletCount} wallets`, { parse_mode: 'Markdown' });

    for (let i = 0; i < n && STATE.running && !isShuttingDown; i++) {
        let buyMult, sellFrac;
        const progress = i / Math.max(n - 1, 1);

        // Pattern logic
        switch (pattern) {
            case 'ASCENDING':
                buyMult = 0.5 + progress;
                sellFrac = 0.3 + (1 - progress) * 0.4;
                break;
            case 'DESCENDING':
                buyMult = 1.5 - progress;
                sellFrac = 0.3 + progress * 0.6;
                break;
            case 'SIDEWAYS':
                buyMult = 0.9 + Math.sin(progress * Math.PI * 4) * 0.2;
                sellFrac = 0.85;
                break;
            case 'CUP_HANDLE':
                const cup = Math.sin(progress * Math.PI);
                const handle = progress > 0.8 ? 0.3 * Math.sin((progress - 0.8) * Math.PI / 0.2) : 0;
                buyMult = 0.4 + cup * 0.8 - handle * 0.3;
                sellFrac = 0.5 + (1 - cup) * 0.4;
                break;
            case 'BREAKOUT':
            default:
                buyMult = progress < 0.7 ? 0.6 : 1.8;
                sellFrac = progress < 0.7 ? 0.9 : 0.2;
        }

        const activeWallets = usePool ? walletPool.getRandomSubset(walletCount) : [masterKeypair];
        bot.sendMessage(chatId, `📐 Cycle ${i + 1}/${n} [${pattern}] | BuyMult: \`${buyMult.toFixed(2)}x\` | Sell: \`${(sellFrac * 100).toFixed(0)}%\``, { parse_mode: 'Markdown' });

        // Buy phase
        await BatchSwapEngine.executeBatch(
            activeWallets,
            async (w) => {
                const jitteredBuy = parseFloat((
                    STATE.minBuyAmount + 
                    (STATE.maxBuyAmount - STATE.minBuyAmount) * 
                    buyMult * 0.7 * 
                    (0.85 + Math.random() * 0.3)
                ).toFixed(4));
                return await swap(SOL_ADDR, STATE.tokenAddress, w, connection, jitteredBuy, chatId, true);
            },
            STATE.batchConcurrency,
            null,
            () => STATE.running && !isShuttingDown
        );
        
        await sleep(getJitteredInterval(STATE.intervalBetweenActions, STATE.jitterPercentage));

        // Sell phase
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
            () => STATE.running && !isShuttingDown
        );

        if (i < n - 1 && STATE.running && !isShuttingDown) {
            await sleep(getJitteredInterval(STATE.intervalBetweenActions, STATE.jitterPercentage));
        }
    }
    bot.sendMessage(chatId, `✅ Chart pattern *${pattern}* complete.`, { parse_mode: 'Markdown' });
}

// ─────────────────────────────────────────────
// 👥 Strategy: Holder Growth (v2 implementation)
// ─────────────────────────────────────────────
async function executeHolderGrowth(chatId, connection) {
    const usePool = STATE.useWalletPool && walletPool.size > 0;
    const count = usePool ? Math.min(STATE.holderWallets, walletPool.size) : STATE.holderWallets;
    const baseAmt = STATE.holderBuyAmount;
    
    bot.sendMessage(chatId, `👥 *Holder Growth*\n${usePool ? `Using ${count} pool wallets` : `Creating ${count} ephemeral`} @ \`${baseAmt}\` SOL each`, { parse_mode: 'Markdown' });

    const wallets = usePool ? walletPool.getRandomSubset(count) : Array.from({ length: count }, () => Keypair.generate());
    const fundNeeded = baseAmt + 0.003;

    await BatchSwapEngine.executeBatch(
        wallets,
        async (w, i) => {
            if (!usePool) {
                await fundWallets(connection, masterKeypair, [w], fundNeeded, chatId);
                await sleep(1200);
            }
            const amtVariation = getRandomFloat(baseAmt * 0.7, baseAmt * 1.3);
            const txid = await swap(SOL_ADDR, STATE.tokenAddress, w, connection, amtVariation, chatId, true);
            
            if (txid && (i + 1) % Math.max(1, Math.floor(count / 10)) === 0) {
                bot.sendMessage(chatId, `✅ Holder ${i + 1}/${count} created`, { parse_mode: 'Markdown' }).catch(() => {});
            }
            await sleep(getRandomFloat(500, 3000)); // Natural spacing
            return txid;
        },
        STATE.batchConcurrency,
        (p) => {
            if (p.completed === p.total) {
                bot.sendMessage(chatId, `🏁 Holder growth complete: +${p.successes} holders (${p.failures} failed)`, { parse_mode: 'Markdown' });
            }
        },
        () => STATE.running && !isShuttingDown
    );

    if (!usePool) {
        await drainWallets(connection, wallets, masterKeypair.publicKey, chatId);
    }
}

// ─────────────────────────────────────────────
// 🐋 Strategy: Whale Simulation (v2 implementation)
// ─────────────────────────────────────────────
async function executeWhaleSimulation(chatId, connection) {
    const usePool = STATE.useWalletPool && walletPool.size > 0;
    const whaleCount = usePool ? Math.min(5, walletPool.size) : 1;
    const buyAmt = STATE.whaleBuyAmount;
    const dumpPct = STATE.whaleSellPercent / 100;
    const volMult = getVolumeMultiplier();
    
    bot.sendMessage(chatId, `🐋 *Whale Simulation*\n${whaleCount} wallets × \`${buyAmt}\` SOL (Vol: ${volMult.toFixed(1)}x) → dump \`${STATE.whaleSellPercent}%\``, { parse_mode: 'Markdown' });

    const activeWhales = usePool ? walletPool.getRandomSubset(whaleCount) : [masterKeypair];

    // Accumulation phase
    for (let i = 0; i < STATE.numberOfCycles && STATE.running && !isShuttingDown; i++) {
        const jitteredAmt = parseFloat((buyAmt * (0.85 + Math.random() * 0.3) * volMult).toFixed(4));
        bot.sendMessage(chatId, `🐋 Accumulate ${i + 1}/${STATE.numberOfCycles}: \`${jitteredAmt}\` SOL`, { parse_mode: 'Markdown' });
        
        await BatchSwapEngine.executeBatch(
            activeWhales,
            async (w) => await swap(SOL_ADDR, STATE.tokenAddress, w, connection, jitteredAmt, chatId, true),
            STATE.batchConcurrency,
            null,
            () => STATE.running && !isShuttingDown
        );
        await sleep(getPoissonDelay(STATE.intervalBetweenActions * 2));
    }

    if (!STATE.running || isShuttingDown) return;

    // Dump phase: stealth chunks
    bot.sendMessage(chatId, `🔴 Whale dumping ${STATE.whaleSellPercent}% in stealth chunks...`, { parse_mode: 'Markdown' });
    
    for (const w of activeWhales) {
        if (!STATE.running || isShuttingDown) break;
        const bal = await getTokenBalance(connection, w.publicKey, STATE.tokenAddress);
        
        if (bal > 0) {
            const dumpChunks = Math.floor(getRandomFloat(2, 5));
            const chunkPercent = dumpPct / dumpChunks;
            
            for (let c = 0; c < dumpChunks; c++) {
                const dumpAmt = parseFloat((bal * chunkPercent).toFixed(6));
                await swap(STATE.tokenAddress, SOL_ADDR, w, connection, dumpAmt, chatId, true);
                await sleep(getJitteredInterval(800, 15)); // Natural spacing between chunks
            }
        }
    }
    bot.sendMessage(chatId, `🐋 Whale simulation complete.`, { parse_mode: 'Markdown' });
}

// ─────────────────────────────────────────────
// 📊 Strategy: Volume Boost (v2 implementation)
// ─────────────────────────────────────────────
async function executeVolumeBoost(chatId, connection) {
    const usePool = STATE.useWalletPool && walletPool.size > 0;
    const walletCount = usePool ? Math.min(STATE.walletsPerCycle, walletPool.size) : STATE.volumeBoostMultiplier;
    const cycles = STATE.volumeBoostCycles;
    
    bot.sendMessage(chatId, `📊 *Volume Boost*\n${usePool ? `${walletCount} pool wallets` : `${walletCount} ephemeral`} × ${cycles} cycles`, { parse_mode: 'Markdown' });

    const wallets = usePool ? walletPool.getRandomSubset(walletCount) : Array.from({ length: walletCount }, () => Keypair.generate());
    
    // Fund ephemeral wallets only
    if (!usePool) {
        const fundAmt = STATE.volumeBoostMaxAmount + 0.01;
        bot.sendMessage(chatId, `💸 Funding ${walletCount} wallets @ \`${fundAmt}\` SOL...`, { parse_mode: 'Markdown' });
        
        for (let i = 0; i < wallets.length && STATE.running && !isShuttingDown; i++) {
            try {
                await fundWallets(connection, masterKeypair, [wallets[i]], fundAmt, chatId);
                if ((i + 1) % 10 === 0 || i === wallets.length - 1) {
                    bot.sendMessage(chatId, `💸 Funded ${i + 1}/${walletCount}`, { parse_mode: 'Markdown' }).catch(() => {});
                }
            } catch (e) {
                bot.sendMessage(chatId, `⚠️ Fund failed ${i + 1}: ${e.message}`, { parse_mode: 'Markdown' }).catch(() => {});
            }
            await sleep(500);
        }
    }

    // Volume cycles
    for (let cycle = 0; cycle < cycles && STATE.running && !isShuttingDown; cycle++) {
        bot.sendMessage(chatId, `🔄 Volume Cycle ${cycle + 1}/${cycles} | Batch buys...`, { parse_mode: 'Markdown' });
        
        // Batch buys with random offset (anti-pattern)
        await BatchSwapEngine.executeBatch(
            wallets,
            async (w, idx) => {
                await sleep(getRandomFloat(0, 2000)); // Random start offset
                const amt = parseFloat(getRandomFloat(STATE.volumeBoostMinAmount, STATE.volumeBoostMaxAmount).toFixed(4));
                return swap(SOL_ADDR, STATE.tokenAddress, w, connection, amt, chatId, true);
            },
            STATE.batchConcurrency,
            null,
            () => STATE.running && !isShuttingDown
        );
        
        await sleep(getJitteredInterval(3000, STATE.jitterPercentage));

        // Batch sells
        bot.sendMessage(chatId, `📉 Batch sells...`, { parse_mode: 'Markdown' });
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
                    bot.sendMessage(chatId, `✅ Cycle ${cycle + 1}: ${p.successes} sells complete`, { parse_mode: 'Markdown' });
                }
            },
            () => STATE.running && !isShuttingDown
        );

        if (cycle < cycles - 1 && STATE.running && !isShuttingDown) {
            await sleep(getJitteredInterval(STATE.intervalBetweenActions, STATE.jitterPercentage));
        }
    }

    // Drain ephemeral wallets
    if (!usePool) {
        bot.sendMessage(chatId, `🧹 Draining volume wallets...`, { parse_mode: 'Markdown' });
        await drainWallets(connection, wallets, masterKeypair.publicKey, chatId);
    }
    bot.sendMessage(chatId, `✅ Volume Boost complete.`, { parse_mode: 'Markdown' });
}

// ─────────────────────────────────────────────
// 🔥 Strategy: Trending Modes (v2 implementation)
// ─────────────────────────────────────────────
async function executeTrendingStrategy(chatId, connection) {
    const mode = STATE.trendingMode;
    const intensity = STATE.trendingIntensity;
    const usePool = STATE.useWalletPool && walletPool.size > 0;
    const walletCount = usePool ? Math.min(STATE.walletsPerCycle, walletPool.size) : 1;
    
    bot.sendMessage(chatId, `🔥 *Trending: ${mode}* (Intensity: ${intensity}/10)`, { parse_mode: 'Markdown' });

    // VIRAL_PUMP mode
    if (mode === 'VIRAL_PUMP') {
        const cycles = Math.floor(5 + intensity * 2);
        for (let i = 0; i < cycles && STATE.running && !isShuttingDown; i++) {
            const freshWallets = usePool ? walletPool.getRandomSubset(walletCount) : [masterKeypair];
            const buyMult = Math.pow(1.3, i / cycles);
            const buyAmt = parseFloat((STATE.minBuyAmount * buyMult * intensity * 0.3).toFixed(4));
            
            bot.sendMessage(chatId, `🚀 Viral buy ${i + 1}/${cycles}: \`${buyAmt}\` SOL`, { parse_mode: 'Markdown' });
            await BatchSwapEngine.executeBatch(
                freshWallets,
                async (w) => await swap(SOL_ADDR, STATE.tokenAddress, w, connection, buyAmt, chatId, true),
                STATE.batchConcurrency, null, () => STATE.running && !isShuttingDown
            );
            
            // Partial sells every other cycle
            if (i % 2 === 0 && STATE.running && !isShuttingDown) {
                const sellWallets = usePool ? walletPool.getRandomSubset(walletCount) : [masterKeypair];
                await BatchSwapEngine.executeBatch(
                    sellWallets,
                    async (w) => {
                        const bal = await getTokenBalance(connection, w.publicKey, STATE.tokenAddress);
                        if (bal > 0) return swap(STATE.tokenAddress, SOL_ADDR, w, connection, parseFloat((bal * 0.1).toFixed(6)), chatId, true);
                        return null;
                    },
                    STATE.batchConcurrency, null, () => STATE.running && !isShuttingDown
                );
            }
            await sleep(getJitteredInterval(2000, STATE.jitterPercentage));
        }
    }
    // ORGANIC_GROWTH mode
    else if (mode === 'ORGANIC_GROWTH') {
        const cycles = Math.floor(10 + intensity);
        for (let i = 0; i < cycles && STATE.running && !isShuttingDown; i++) {
            const buyAmt = parseFloat(getRandomFloat(STATE.minBuyAmount, STATE.maxBuyAmount).toFixed(4));
            const randomWallets = usePool ? walletPool.getRandomSubset(Math.max(1, Math.floor(walletCount * 0.2))) : [masterKeypair];
            
            bot.sendMessage(chatId, `🌱 Organic buy ${i + 1}/${cycles}: \`${buyAmt}\` SOL`, { parse_mode: 'Markdown' });
            await BatchSwapEngine.executeBatch(
                randomWallets, 
                async (w) => await swap(SOL_ADDR, STATE.tokenAddress, w, connection, buyAmt, chatId, true), 
                STATE.batchConcurrency, null, () => STATE.running && !isShuttingDown
            );
            
            const pause = getJitteredInterval(5000 + intensity * 2000, 50);
            await sleep(pause);
            
            // Occasional sells
            if (Math.random() < 0.2 && STATE.running && !isShuttingDown) {
                const sellWallets = usePool ? walletPool.getRandomSubset(randomWallets.length) : [masterKeypair];
                await BatchSwapEngine.executeBatch(
                    sellWallets, 
                    async (w) => {
                        const bal = await getTokenBalance(connection, w.publicKey, STATE.tokenAddress);
                        if (bal > 0) return swap(STATE.tokenAddress, SOL_ADDR, w, connection, parseFloat((bal * 0.15).toFixed(6)), chatId, true);
                        return null;
                    }, 
                    STATE.batchConcurrency, null, () => STATE.running && !isShuttingDown
                );
            }
        }
    }
    // FOMO_WAVE mode
    else if (mode === 'FOMO_WAVE') {
        const waves = Math.floor(2 + intensity * 0.5);
        for (let wave = 0; wave < waves && STATE.running && !isShuttingDown; wave++) {
            bot.sendMessage(chatId, `🌊 FOMO Wave ${wave + 1}/${waves} - Rapid buys!`, { parse_mode: 'Markdown' });
            const buysPerWave = Math.floor(3 + intensity);
            
            for (let i = 0; i < buysPerWave && STATE.running && !isShuttingDown; i++) {
                const buyAmt = parseFloat(getRandomFloat(STATE.minBuyAmount * 1.5, STATE.maxBuyAmount * 2).toFixed(4));
                const surgeWallets = usePool ? walletPool.getRandomSubset(Math.max(1, Math.floor(walletCount * 0.4))) : [masterKeypair];
                
                await BatchSwapEngine.executeBatch(
                    surgeWallets, 
                    async (w) => await swap(SOL_ADDR, STATE.tokenAddress, w, connection, buyAmt, chatId, true), 
                    STATE.batchConcurrency, null, () => STATE.running && !isShuttingDown
                );
                await sleep(1500);
            }
            
            if (wave < waves - 1 && STATE.running && !isShuttingDown) {
                const cooldown = getJitteredInterval(15000 + intensity * 3000, 30);
                bot.sendMessage(chatId, `⏸️ Cooldown: ${Math.round(cooldown / 1000)}s...`, { parse_mode: 'Markdown' });
                await sleep(cooldown);
            }
        }
    }
    // LIQUIDITY_LADDER mode
    else if (mode === 'LIQUIDITY_LADDER') {
        const steps = Math.floor(5 + intensity);
        for (let i = 0; i < steps && STATE.running && !isShuttingDown; i++) {
            const stepMult = 1 + (i / steps) * intensity * 0.4;
            const buyAmt = parseFloat((STATE.minBuyAmount * stepMult).toFixed(4));
            const ladders = usePool ? walletPool.getRandomSubset(Math.max(1, Math.floor(walletCount * 0.3))) : [masterKeypair];
            
            bot.sendMessage(chatId, `🪜 Ladder step ${i + 1}/${steps}: \`${buyAmt}\` SOL`, { parse_mode: 'Markdown' });
            await BatchSwapEngine.executeBatch(
                ladders, 
                async (w) => await swap(SOL_ADDR, STATE.tokenAddress, w, connection, buyAmt, chatId, true), 
                STATE.batchConcurrency, null, () => STATE.running && !isShuttingDown
            );
            await sleep(getJitteredInterval(STATE.intervalBetweenActions, STATE.jitterPercentage));
        }
    }
    // WASH_TRADING mode
    else if (mode === 'WASH_TRADING') {
        const pairs = Math.floor(10 + intensity * 3);
        bot.sendMessage(chatId, `🔄 Wash Trading: ${pairs} pairs`, { parse_mode: 'Markdown' });
        
        for (let i = 0; i < pairs && STATE.running && !isShuttingDown; i++) {
            const amt = parseFloat(getRandomFloat(STATE.minBuyAmount * 0.5, STATE.maxBuyAmount * 0.7).toFixed(4));
            const buyers = usePool ? walletPool.getRandomSubset(1) : [masterKeypair];
            const sellers = usePool ? walletPool.getRandomSubset(1) : [masterKeypair];
            
            await BatchSwapEngine.executeBatch(
                buyers, 
                async (w) => await swap(SOL_ADDR, STATE.tokenAddress, w, connection, amt, chatId, true), 
                STATE.batchConcurrency, null, () => STATE.running && !isShuttingDown
            );
            await sleep(getJitteredInterval(2000, 10));
            
            await BatchSwapEngine.executeBatch(
                sellers, 
                async (w) => {
                    const bal = await getTokenBalance(connection, w.publicKey, STATE.tokenAddress);
                    if (bal > 0) return swap(STATE.tokenAddress, SOL_ADDR, w, connection, 'auto', chatId, true);
                    return null;
                }, 
                STATE.batchConcurrency, null, () => STATE.running && !isShuttingDown
            );
            
            if ((i + 1) % 5 === 0) bot.sendMessage(chatId, `🔄 Progress: ${i + 1}/${pairs}`, { parse_mode: 'Markdown' }).catch(() => {});
            await sleep(getJitteredInterval(3000, STATE.jitterPercentage));
        }
    }
    
    bot.sendMessage(chatId, `🏁 Trending strategy *${mode}* complete!`, { parse_mode: 'Markdown' });
}

// ─────────────────────────────────────────────
// 🚀 Strategy: Pump & Dump (v2 implementation)
// ─────────────────────────────────────────────
async function executePumpDump(chatId, connection) {
    const usePool = STATE.useWalletPool && walletPool.size > 0;
    const walletCount = usePool ? Math.min(STATE.walletsPerCycle, walletPool.size) : 1;
    
    bot.sendMessage(chatId, `🚀 *Pump & Dump*\nAccumulating across ${STATE.numberOfCycles} cycles`, { parse_mode: 'Markdown' });

    // Accumulation phase
    for (let i = 0; i < STATE.numberOfCycles && STATE.running && !isShuttingDown; i++) {
        const activeWallets = usePool ? walletPool.getRandomSubset(walletCount) : [masterKeypair];
        
        for (const w of activeWallets) {
            if (!STATE.running || isShuttingDown) break;
            const buyAmount = parseFloat(getRandomFloat(STATE.minBuyAmount, STATE.maxBuyAmount).toFixed(4));
            await swap(SOL_ADDR, STATE.tokenAddress, w, connection, buyAmount, chatId, true);
            await sleep(getPoissonDelay(getRandomFloat(2000, 5000)));
        }
        await sleep(getPoissonDelay(STATE.intervalBetweenActions));
    }

    if (!STATE.running || isShuttingDown) return;

    // Dump phase: stealth chunks
    const dumpWallets = usePool ? walletPool.getRandomSubset(Math.min(5, walletPool.size)) : [masterKeypair];
    bot.sendMessage(chatId, `🔴 *Dumping in stealth chunks*...`, { parse_mode: 'Markdown' });
    
    for (const w of dumpWallets) {
        if (!STATE.running || isShuttingDown) break;
        const bal = await getTokenBalance(connection, w.publicKey, STATE.tokenAddress);
        
        if (bal > 0) {
            const chunks = Math.floor(getRandomFloat(2, 4));
            const chunkSize = bal / chunks;
            
            for (let c = 0; c < chunks; c++) {
                const amt = (c === chunks-1) ? 'auto' : chunkSize.toFixed(6);
                await swap(STATE.tokenAddress, SOL_ADDR, w, connection, amt, chatId, true);
                await sleep(getJitteredInterval(1000, 20));
            }
        }
    }
}

// ─────────────────────────────────────────────
// 🌪️ Strategy: Jito MEV Wash (v2 implementation)
// ─────────────────────────────────────────────
async function executeJitoMevWash(chatId, connection) {
    if (!STATE.useJito) {
        bot.sendMessage(chatId, `❌ Enable Jito in settings to use MEV Wash!`, { parse_mode: 'Markdown' });
        return;
    }
    
    const cycles = STATE.numberOfCycles;
    const usePool = STATE.useWalletPool && walletPool.size > 0;
    
    bot.sendMessage(chatId, `🌪️ *JITO MEV Wash*\n${cycles} bundled buy/sell cycles`, { parse_mode: 'Markdown' });

    for (let i = 0; i < cycles && STATE.running && !isShuttingDown; i++) {
        const amt = parseFloat(getRandomFloat(STATE.minBuyAmount, STATE.maxBuyAmount).toFixed(4));
        const buyWallet = usePool ? walletPool.getRandomSubset(1)[0] : masterKeypair;
        
        bot.sendMessage(chatId, `🌪️ Wash Bundle ${i + 1}/${cycles}: \`${amt}\` SOL`, { parse_mode: 'Markdown' });
        
        try {
            // Buy
            const buyId = await swap(SOL_ADDR, STATE.tokenAddress, buyWallet, connection, amt, chatId, true);
            if (buyId) {
                await sleep(1000); // Brief delay for indexing
                // Sell (same wallet for simplicity)
                await swap(STATE.tokenAddress, SOL_ADDR, buyWallet, connection, 'auto', chatId, true);
            }
        } catch (err) {
            logger.error(`[MEV Wash] Error: ${err.message}`);
            bot.sendMessage(chatId, `⚠️ Wash Error: ${err.message}`, { parse_mode: 'Markdown' }).catch(() => {});
        }
        await sleep(getJitteredInterval(STATE.intervalBetweenActions, STATE.jitterPercentage));
    }
    bot.sendMessage(chatId, `✅ JITO MEV Wash complete.`, { parse_mode: 'Markdown' });
}

// ─────────────────────────────────────────────
// 📱 Strategy: KOL Alpha Call (v2 implementation)
// ─────────────────────────────────────────────
async function executeKolAlphaCall(chatId, connection) {
    const usePool = STATE.useWalletPool && walletPool.size > 0;
    const swarmSize = Math.min(STATE.kolRetailSwarmSize, usePool ? walletPool.size : 20);
    
    bot.sendMessage(chatId, `📱 *KOL Alpha Call*\n1 Whale + ${swarmSize} Retail followers`, { parse_mode: 'Markdown' });

    // Whale buy
    const whaleWallet = usePool ? walletPool.getRandomSubset(1)[0] : masterKeypair;
    const whaleAmt = parseFloat((getRandomFloat(STATE.maxBuyAmount * 2, STATE.maxBuyAmount * 5)).toFixed(4));
    bot.sendMessage(chatId, `🐋 Whale buy: \`${whaleAmt}\` SOL`, { parse_mode: 'Markdown' });
    await swap(SOL_ADDR, STATE.tokenAddress, whaleWallet, connection, whaleAmt, chatId, true);
    await sleep(2000);

    // Retail swarm
    const swarmWallets = usePool ? walletPool.getRandomSubset(swarmSize) : Array.from({ length: swarmSize }, () => Keypair.generate());
    
    if (!usePool) {
        bot.sendMessage(chatId, `🐟 Funding ${swarmSize} retail wallets...`, { parse_mode: 'Markdown' });
        await fundWallets(connection, masterKeypair, swarmWallets, STATE.minBuyAmount + 0.005, chatId);
    }

    bot.sendMessage(chatId, `🚀 Retail FOMO: ${swarmWallets.length} wallets`, { parse_mode: 'Markdown' });
    await BatchSwapEngine.executeBatch(
        swarmWallets,
        (w) => {
            const amt = parseFloat(getRandomFloat(STATE.minBuyAmount * 0.1, STATE.minBuyAmount * 0.8).toFixed(4));
            return swap(SOL_ADDR, STATE.tokenAddress, w, connection, amt, chatId, true);
        },
        STATE.batchConcurrency,
        (p) => {
            if (p.completed === p.total) {
                bot.sendMessage(chatId, `✅ KOL Call: ${p.successes} retail buys executed`, { parse_mode: 'Markdown' });
            }
        },
        () => STATE.running && !isShuttingDown
    );

    if (!usePool) {
        await drainWallets(connection, swarmWallets, masterKeypair.publicKey, chatId);
    }
}

// ─────────────────────────────────────────────
// 🐻 Strategy: Bull Trap (v2 implementation)
// ─────────────────────────────────────────────
async function executeBullTrap(chatId, connection) {
    bot.sendMessage(chatId, `🐻 *Bull Trap*\nFake breakout → stealth dump`, { parse_mode: 'Markdown' });

    const usePool = STATE.useWalletPool && walletPool.size > 0;
    const steps = Math.floor(getRandomFloat(4, 7));
    const trapWallet = usePool ? walletPool.getRandomSubset(1)[0] : masterKeypair;

    // Fake breakout buys
    let totalBought = 0;
    for (let i = 0; i < steps && STATE.running && !isShuttingDown; i++) {
        const buyAmt = Math.random() < 0.3 
            ? getRandomFloat(STATE.minBuyAmount * 1.5, STATE.maxBuyAmount * 2)
            : getRandomFloat(STATE.minBuyAmount, STATE.maxBuyAmount);
        const finalAmt = parseFloat(buyAmt.toFixed(4));
        
        bot.sendMessage(chatId, `📈 Bait ${i+1}/${steps}: \`${finalAmt}\` SOL`, { parse_mode: 'Markdown' });
        const txid = await swap(SOL_ADDR, STATE.tokenAddress, trapWallet, connection, finalAmt, chatId, true);
        if (txid) totalBought += finalAmt;
        
        const delay = getJitteredInterval(Math.floor(getRandomFloat(1000, 4000)), STATE.jitterPercentage);
        await sleep(delay);
    }

    if (!STATE.running || isShuttingDown) return;

    // Wait for "others" to react
    const waitTime = getJitteredInterval(Math.floor(getRandomFloat(5000, 12000)), STATE.jitterPercentage);
    bot.sendMessage(chatId, `⏳ Waiting \`${Math.round(waitTime/1000)}s\` for reaction...`, { parse_mode: 'Markdown' });
    const startWait = Date.now();
    
    while (Date.now() - startWait < waitTime && STATE.running && !isShuttingDown) {
        // Simulate other wallets taking profits
        if (Math.random() < 0.2 && usePool && walletPool.size > 0) {
            const randomSeller = walletPool.getRandomSubset(1)[0];
            const tokenBal = await getTokenBalance(connection, randomSeller.publicKey, STATE.tokenAddress);
            if (tokenBal > 0.001) {
                const sellPct = getRandomFloat(0.1, 0.4);
                const sellAmt = parseFloat((tokenBal * sellPct).toFixed(6));
                await swap(STATE.tokenAddress, SOL_ADDR, randomSeller, connection, sellAmt, chatId, true);
                await sleep(getJitteredInterval(500, 20));
            }
        }
        await sleep(1000);
    }

    if (!STATE.running || isShuttingDown) return;

    // Dump phase
    const totalTokens = await getTokenBalance(connection, trapWallet.publicKey, STATE.tokenAddress);
    if (totalTokens <= 0) {
        bot.sendMessage(chatId, `⚠️ No tokens to dump. Aborted.`, { parse_mode: 'Markdown' });
        return;
    }

    const oldSlippage = STATE.slippage;
    STATE.slippage = STATE.bullTrapSlippage || 20;
    
    const chunks = Math.floor(getRandomFloat(2, 5));
    const chunkSize = totalTokens / chunks;
    bot.sendMessage(chatId, `🔴 Dumping \`${totalTokens.toFixed(4)}\` tokens in ${chunks} chunks @ ${STATE.slippage}% slippage`, { parse_mode: 'Markdown' });

    for (let c = 0; c < chunks && STATE.running && !isShuttingDown; c++) {
        const amountToSell = (c === chunks - 1) ? 'auto' : chunkSize.toFixed(6);
        await swap(STATE.tokenAddress, SOL_ADDR, trapWallet, connection, amountToSell, chatId, true);
        if (c < chunks - 1) {
            await sleep(getJitteredInterval(Math.floor(getRandomFloat(500, 2000)), STATE.jitterPercentage));
        }
    }

    STATE.slippage = oldSlippage;
    bot.sendMessage(chatId, `✅ Bull Trap complete: dumped in ${chunks} chunks.`, { parse_mode: 'Markdown' });
}

// ─────────────────────────────────────────────
// 🎁 Strategy: Social Proof Airdrop (v2 implementation)
// ─────────────────────────────────────────────
async function executeSocialProofAirdrop(chatId, connection) {
    const usePool = STATE.useWalletPool && walletPool.size > 0;
    const wCount = usePool ? Math.min(STATE.airdropWalletCount, walletPool.size) : Math.min(STATE.airdropWalletCount, 30);
    
    bot.sendMessage(chatId, `🎁 *Social Proof Airdrop*\n${usePool ? `${wCount} pool wallets` : `${wCount} ephemeral wallets`}`, { parse_mode: 'Markdown' });

    const swarmWallets = usePool ? walletPool.getRandomSubset(wCount) : Array.from({ length: wCount }, () => Keypair.generate());
    
    // Fund ephemeral wallets
    if (!usePool) {
        const fundAmt = 0.015;
        bot.sendMessage(chatId, `💸 Funding ${wCount} wallets @ \`${fundAmt}\` SOL...`, { parse_mode: 'Markdown' });
        
        await BatchSwapEngine.executeBatch(
            swarmWallets,
            async (w, i) => {
                await fundWallets(connection, masterKeypair, [w], fundAmt, chatId);
                if ((i + 1) % Math.max(1, Math.floor(wCount / 5)) === 0) {
                    bot.sendMessage(chatId, `💸 Funded ${i + 1}/${wCount}`, { parse_mode: 'Markdown' }).catch(() => {});
                }
            },
            STATE.batchConcurrency,
            null,
            () => STATE.running && !isShuttingDown
        );
    }

    // Execute swarm buys
    bot.sendMessage(chatId, `🚀 Swarm buys: ${swarmWallets.length} wallets`, { parse_mode: 'Markdown' });
    await BatchSwapEngine.executeBatch(
        swarmWallets,
        async (w, index) => {
            const amt = getRandomFloat(0.0005, 0.01);
            const txid = await swap(SOL_ADDR, STATE.tokenAddress, w, connection, amt, chatId, true);
            await sleep(getRandomFloat(2000, 8000)); // Natural spacing
            return txid;
        },
        STATE.batchConcurrency,
        (p) => {
            if (p.completed === p.total) {
                bot.sendMessage(chatId, `✅ Airdrop complete: +${p.successes} holders created (${p.failures} failed)`, { parse_mode: 'Markdown' });
            }
        },
        () => STATE.running && !isShuttingDown
    );

    if (!usePool) {
        await drainWallets(connection, swarmWallets, masterKeypair.publicKey, chatId);
    }
}

// ─────────────────────────────────────────────
// 🎮 Master Engine Controller
// ─────────────────────────────────────────────
async function startEngine(chatId) {
    if (!masterKeypair) {
        bot.sendMessage(chatId, `❌ No wallet loaded! Add PRIVKEY to .env and restart.`, { parse_mode: 'Markdown' });
        return;
    }
    if (!STATE.tokenAddress) {
        bot.sendMessage(chatId, `❌ Set Token CA first via ⚙️ Config.`, { parse_mode: 'Markdown' });
        return;
    }

    try {
        await withRpcFallback(async (connection) => {
            STATE.running = true;
            saveConfig(); // Persist running state
            
            const balance = await connection.getBalance(masterKeypair.publicKey) / LAMPORTS_PER_SOL;
            const shortAddr = masterKeypair.publicKey.toBase58().slice(0, 8) + '...';
            
            bot.sendMessage(chatId, 
                `💰 *Master Wallet*\n` +
                `📍 ${shortAddr}\n` +
                `💎 Balance: \`${balance.toFixed(4)}\` SOL\n\n` +
                `🚀 Launching *${STATE.strategy}*...\n` +
                `📈 Jito: \`${STATE.useJito ? 'ON' : 'OFF'}\` | Vol Curve: \`${STATE.useVolumeCurve ? 'ON' : 'OFF'}\`\n` +
                `🛡️ Stealth: \`${STATE.fundingStealthLevel === 2 ? 'Multi-hop' : 'Direct'}\``, 
                { parse_mode: 'Markdown' }
            );

            // Balance warnings
            if (balance < 0.001) {
                bot.sendMessage(chatId, `⚠️ *Warning:* Very low SOL balance (\`${balance.toFixed(4)}\`). Operations may fail.`, { parse_mode: 'Markdown' });
            }
            if (balance < STATE.minBuyAmount + STATE.priorityFee + 0.001) {
                bot.sendMessage(chatId, `❌ *Insufficient SOL:* Need \`${(STATE.minBuyAmount + STATE.priorityFee + 0.001).toFixed(4)}\` SOL minimum.`, { parse_mode: 'Markdown' });
                STATE.running = false;
                return;
            }

            // Strategy dispatch
            const strategies = {
                "STANDARD": executeStandardCycles,
                "MAKER": executeMakerCycles,
                "WEB_OF_ACTIVITY": executeWebOfActivity,
                "SPAM": executeSpamMode,
                "PUMP_DUMP": executePumpDump,
                "CHART_PATTERN": executeChartPattern,
                "HOLDER_GROWTH": executeHolderGrowth,
                "WHALE": executeWhaleSimulation,
                "VOLUME_BOOST": executeVolumeBoost,
                "TRENDING": executeTrendingStrategy,
                "JITO_MEV_WASH": executeJitoMevWash,
                "KOL_ALPHA_CALL": executeKolAlphaCall,
                "BULL_TRAP": executeBullTrap,
                "SOCIAL_PROOF_AIRDROP": executeSocialProofAirdrop
            };
            
            const strategy = strategies[STATE.strategy];
            if (strategy) {
                await strategy(chatId, connection);
            } else {
                throw new Error(`Unknown strategy: ${STATE.strategy}`);
            }

            if (STATE.running && !isShuttingDown) {
                bot.sendMessage(chatId, `🏁 *Strategy Complete!*`, { parse_mode: "Markdown" });
            }
            STATE.running = false;
            saveConfig(); // Persist completion
        });
    } catch (e) {
        logger.error(`[Engine] Fatal error: ${e.message}\n${e.stack}`);
        bot.sendMessage(chatId, `⚠️ Engine Error: ${e.message}`, { parse_mode: 'Markdown' }).catch(() => {});
        STATE.running = false;
    }
}

// ─────────────────────────────────────────────
// 🎛️ Telegram UI: Main Menu
// ─────────────────────────────────────────────
function showMainMenu(chatId) {
    const statusIcon = STATE.running ? '🟢' : '🔴';
    const statusText = STATE.running ? 'RUNNING' : 'IDLE';
    
    bot.sendMessage(chatId,
        `╔═══════════════════════╗\n` +
        `║  🤖 *Volume Bot v3.0*  ║\n` +
        `╚═══════════════════════╝\n\n` +
        `⚡ *Status:* ${statusIcon} ${statusText}\n` +
        `🎯 *Strategy:* \`${STATE.strategy}\`\n` +
        `💼 *Pool:* \`${walletPool.size.toLocaleString()}\` wallets\n` +
        `🪙 *Token:* ${STATE.tokenAddress ? '✅ Set' : '❌ Not Set'}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━`,
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: (STATE.running ? '🛑 STOP' : '🚀 LAUNCH'), callback_data: (STATE.running ? 'stop_cycles' : 'start_cycles') }],
                    [{ text: '📈 Strategies', callback_data: 'strategies' }, { text: '⚙️ Settings', callback_data: 'settings' }],
                    [{ text: '💼 Wallet Pool', callback_data: 'wallet_pool' }, { text: '📊 Dashboard', callback_data: 'status' }],
                    [{ text: '📜 My Wallet', callback_data: 'show_wallet' }, { text: '❓ Help', callback_data: 'help' }]
                ]
            }
        }
    );
}

// ─────────────────────────────────────────────
// 🎛️ Telegram UI: Strategy Menu
// ─────────────────────────────────────────────
function showStrategyMenu(chatId) {
    const s = STATE.strategy;
    bot.sendMessage(chatId,
        `📈 *STRATEGY SELECTION*\n━━━━━━━━━━━━━━━━━━━━━━━\nCurrent: *${s}*\n\nChoose:`,
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: (s === 'STANDARD' ? '✅ ' : '') + '🌐 Standard', callback_data: 'strat_standard' }, { text: (s === 'MAKER' ? '✅ ' : '') + '📈 Maker', callback_data: 'strat_maker' }],
                    [{ text: (s === 'WEB_OF_ACTIVITY' ? '✅ ' : '') + '🕸️ Web', callback_data: 'strat_web' }, { text: (s === 'SPAM' ? '✅ ' : '') + '⚡ Spam', callback_data: 'strat_spam' }],
                    [{ text: (s === 'PUMP_DUMP' ? '✅ ' : '') + '🚀 Pump&Dump', callback_data: 'strat_pumpdump' }, { text: (s === 'CHART_PATTERN' ? '✅ ' : '') + '📐 Chart', callback_data: 'strat_chart' }],
                    [{ text: (s === 'HOLDER_GROWTH' ? '✅ ' : '') + '👥 Holders', callback_data: 'strat_holder' }, { text: (s === 'WHALE' ? '✅ ' : '') + '🐋 Whale', callback_data: 'strat_whale' }],
                    [{ text: (s === 'VOLUME_BOOST' ? '✅ ' : '') + '📊 Boost', callback_data: 'strat_volume' }, { text: (s === 'TRENDING' ? '✅ ' : '') + '🔥 Trending', callback_data: 'strat_trending' }],
                    [{ text: (s === 'JITO_MEV_WASH' ? '✅ ' : '') + '🌪️ MEV Wash', callback_data: 'strat_mev_wash' }, { text: (s === 'KOL_ALPHA_CALL' ? '✅ ' : '') + '📱 KOL', callback_data: 'strat_kol' }],
                    [{ text: (s === 'BULL_TRAP' ? '✅ ' : '') + '🐻 Bull Trap', callback_data: 'strat_bull' }, { text: (s === 'SOCIAL_PROOF_AIRDROP' ? '✅ ' : '') + '🎁 Airdrop', callback_data: 'strat_airdrop' }],
                    [{ text: '« Back', callback_data: 'back_to_main' }]
                ]
            }
        }
    );
}

// ─────────────────────────────────────────────
// 🎛️ Telegram UI: Settings Menu
// ─────────────────────────────────────────────
function showSettingsMenu(chatId) {
    bot.sendMessage(chatId,
        `⚙️ *CONFIGURATION*\n━━━━━━━━━━━━━━━━━━━━━━━\n\nCategory:`,
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '📱 Basic', callback_data: 'settings_basic' }, { text: '⚡ Advanced', callback_data: 'settings_advanced' }],
                    [{ text: '🎯 Strategy', callback_data: 'settings_strat' }, { text: '🎭 Realism', callback_data: 'show_realism' }],
                    [{ text: '🔌 Provider', callback_data: 'provider_settings' }, { text: '🛡️ Jito', callback_data: 'settings_jito' }],
                    [{ text: '🕸️ Stealth', callback_data: 'stealth_settings' }, { text: '« Back', callback_data: 'back_to_main' }]
                ]
            }
        }
    );
}

// ─────────────────────────────────────────────
// 🎛️ Telegram UI: Basic Settings
// ─────────────────────────────────────────────
function showBasicSettings(chatId) {
    const tokenStatus = STATE.tokenAddress 
        ? `\`${STATE.tokenAddress.slice(0,8)}...${STATE.tokenAddress.slice(-4)}\`` 
        : '❌ Not Set';
    
    bot.sendMessage(chatId,
        `📱 *BASIC CONFIG*\n━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `🪙 *Token:* ${tokenStatus}\n` +
        `💰 *Buy:* \`${STATE.minBuyAmount}\` - \`${STATE.maxBuyAmount}\` SOL\n` +
        `🔁 *Cycles:* \`${STATE.numberOfCycles}\`\n` +
        `⏱ *Delay:* \`${STATE.intervalBetweenActions / 1000}s\`\n` +
        `🎲 *Jitter:* \`${STATE.jitterPercentage}%\``,
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🪙 Token CA', callback_data: 'set_token_address' }],
                    [{ text: '💰 Min Buy', callback_data: 'set_min_buy' }, { text: '💰 Max Buy', callback_data: 'set_max_buy' }],
                    [{ text: '🔁 Cycles', callback_data: 'set_cycles' }, { text: '🎲 Jitter', callback_data: 'set_jitter' }],
                    [{ text: '⏱ Delay', callback_data: 'set_interval' }],
                    [{ text: '« Back', callback_data: 'settings' }]
                ]
            }
        }
    );
}

// ─────────────────────────────────────────────
// 🎛️ Telegram UI: Advanced Settings
// ─────────────────────────────────────────────
function showAdvancedSettings(chatId) {
    bot.sendMessage(chatId,
        `⚡ *Advanced Settings*\n\n` +
        `• Priority Fee: \`${STATE.priorityFee}\` SOL\n` +
        `• Slippage: \`${STATE.slippage}%\`\n` +
        `• Batch Concurrency: \`${STATE.batchConcurrency}\`\n` +
        `• Wallets/Cycle: \`${STATE.walletsPerCycle}\`\n` +
        `• Sync Buys/Sells: \`${STATE.maxSimultaneousBuys}/${STATE.maxSimultaneousSells}\``,
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '💸 Fee', callback_data: 'set_fees' }, { text: '📉 Slippage', callback_data: 'set_slippage' }],
                    [{ text: '⚡ Concurrency', callback_data: 'set_batch_concurrency' }, { text: '👥 Wallets/Cycle', callback_data: 'set_wallets_per_cycle' }],
                    [{ text: '🔄 Sync Buys/Sells', callback_data: 'set_sync' }],
                    [{ text: '🔙 Back', callback_data: 'settings' }]
                ]
            }
        }
    );
}

// ─────────────────────────────────────────────
// 🎛️ Telegram UI: Stealth Settings
// ─────────────────────────────────────────────
function showStealthSettings(chatId) {
    bot.sendMessage(chatId,
        `🕸️ *Stealth Settings*\n\n` +
        `• Web Funding: ${STATE.useWebFunding ? '🟢 ON' : '🔴 OFF'}\n` +
        `• Stealth Level: ${STATE.fundingStealthLevel === 2 ? '🌪️ Multi-hop' : '📡 Direct'}\n` +
        `• Max Hop Depth: \`${STATE.makerFundingChainDepth}\``,
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: `Web Funding ${STATE.useWebFunding ? '🔴' : '🟢'}`, callback_data: 'toggle_web_funding' }],
                    [{ text: `Level: ${STATE.fundingStealthLevel === 2 ? '➡️ Direct' : '⬅️ Multi-hop'}`, callback_data: 'toggle_stealth_level' }],
                    [{ text: '🔗 Max Depth', callback_data: 'set_maker_depth' }],
                    [{ text: '🔙 Back', callback_data: 'settings' }]
                ]
            }
        }
    );
}

// ─────────────────────────────────────────────
// 🎛️ Telegram UI: Realism Settings
// ─────────────────────────────────────────────
function showRealismMenu(chatId) {
    bot.sendMessage(chatId,
        `🎭 *Realism Engine*\n\n` +
        `• Engine: ${STATE.realismMode ? '🟢 ON' : '🔴 OFF'}\n` +
        `• Human Delays: ${STATE.humanizedDelays ? '🟢 ON' : '🔴 OFF'}\n` +
        `• Poisson Timing: ${STATE.usePoissonTiming ? '🟢 ON' : '🔴 OFF'}\n` +
        `• Variable Slippage: ${STATE.variableSlippage ? '🟢 ON' : '🔴 OFF'}\n` +
        `• Volume Curve: ${STATE.useVolumeCurve ? '🟢 ON' : '🔴 OFF'}`,
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: `Engine ${STATE.realismMode ? '🔴' : '🟢'}`, callback_data: 'toggle_realism' }],
                    [{ text: `Delays ${STATE.humanizedDelays ? '🔴' : '🟢'}`, callback_data: 'toggle_delays' }],
                    [{ text: `Poisson ${STATE.usePoissonTiming ? '🔴' : '🟢'}`, callback_data: 'toggle_poisson' }],
                    [{ text: `Slippage ${STATE.variableSlippage ? '🔴' : '🟢'}`, callback_data: 'toggle_varslip' }],
                    [{ text: `Volume ${STATE.useVolumeCurve ? '🔴' : '🟢'}`, callback_data: 'toggle_vol_curve' }],
                    [{ text: '🔙 Back', callback_data: 'settings' }]
                ]
            }
        }
    );
}

// ─────────────────────────────────────────────
// 🎛️ Telegram UI: Jito Settings
// ─────────────────────────────────────────────
function showJitoSettings(chatId) {
    bot.sendMessage(chatId,
        `🛡️ *Jito MEV Protection*\n\n` +
        `• Status: *${STATE.useJito ? '🟢 ENABLED' : '🔴 DISABLED'}*\n` +
        `• Tip: \`${STATE.jitoTipAmount}\` SOL`,
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: `Toggle ${STATE.useJito ? '🔴' : '🟢'}`, callback_data: 'set_jito' }],
                    [{ text: '💵 Set Tip', callback_data: 'set_jito_tip' }],
                    [{ text: '🔙 Back', callback_data: 'settings' }]
                ]
            }
        }
    );
}

// ─────────────────────────────────────────────
// 🎛️ Telegram UI: Provider Settings
// ─────────────────────────────────────────────
function showProviderMenu(chatId) {
    const p = STATE.swapProvider;
    bot.sendMessage(chatId,
        `🔌 *Swap Provider*\nCurrent: *${p}*\nDEX: \`${STATE.targetDex}\``,
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: (p === 'SOLANA_TRACKER' ? '✅ ' : '') + '🌐 SolanaTracker', callback_data: 'prov_tracker' }],
                    [{ text: (p === 'SOLANA_TRADE' ? '✅ ' : '') + '🎯 SolanaTrade', callback_data: 'prov_trade' }],
                    [{ text: '🎯 Select DEX', callback_data: 'select_dex' }],
                    [{ text: '🔙 Back', callback_data: 'settings' }]
                ]
            }
        }
    );
}

// ─────────────────────────────────────────────
// 🎛️ Telegram UI: DEX Selection
// ─────────────────────────────────────────────
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

    bot.sendMessage(chatId, `🎯 *Target DEX*\nCurrent: *${current}*`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
    });
}

// ─────────────────────────────────────────────
// 🎛️ Telegram UI: Wallet Pool Menu
// ─────────────────────────────────────────────
function showWalletPoolMenu(chatId) {
    const stats = walletPool.getStats?.() || { total: walletPool.size, firstFew: [] };
    const modeIcon = STATE.useWalletPool ? '🟢' : '🔴';
    
    bot.sendMessage(chatId,
        `💼 *WALLET POOL*\n━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `📊 *Total:* \`${stats.total.toLocaleString()}\`\n` +
        `${modeIcon} *Mode:* ${STATE.useWalletPool ? 'ENABLED' : 'DISABLED'}\n` +
        `⚡ *Concurrency:* \`${STATE.batchConcurrency}\`\n` +
        `👥 *Per Cycle:* \`${STATE.walletsPerCycle}\`\n` +
        `💵 *Fund Amt:* \`${STATE.fundAmountPerWallet}\` SOL\n` +
        `${stats.total > 0 ? `\nSample: \`${stats.firstFew[0]?.slice(0,8)}...\`` : `\n⚠️ No wallets yet`}`,
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

// ─────────────────────────────────────────────
// 🎛️ Telegram UI: Help
// ─────────────────────────────────────────────
function showHelp(chatId) {
    bot.sendMessage(chatId,
        `❓ *Volume Bot v3.0 - Help*\n\n` +
        `*Quick Start:*\n` +
        `1. Set Token CA in ⚙️ Config\n` +
        `2. Choose strategy in 📈 Strategies\n` +
        `3. Hit 🚀 Launch Engine\n\n` +
        `*Pro Tips:*\n` +
        `• Higher Jitter = more human-like\n` +
        `• Maker mode uses more SOL (funds child wallets)\n` +
        `• Use 📊 Dashboard to monitor balances\n` +
        `• Stealth funding (multi-hop) obfuscates on-chain links\n` +
        `• Always test on devnet first!\n\n` +
        `*Safety:*\n` +
        `• Bot auto-saves config on changes\n` +
        `• Graceful shutdown on SIGINT/SIGTERM\n` +
        `• Balance checks prevent failed transactions`,
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[{ text: '« Back', callback_data: 'back_to_main' }]]
            }
        }
    );
}

// ─────────────────────────────────────────────
// 🎛️ Telegram UI: Dashboard
// ─────────────────────────────────────────────
async function showDashboard(chatId) {
    if (!masterKeypair) {
        return bot.sendMessage(chatId, `❌ No wallet loaded.`, { parse_mode: 'Markdown' });
    }
    
    try {
        const connection = getConnection();
        const solBal = await connection.getBalance(masterKeypair.publicKey) / LAMPORTS_PER_SOL;
        let tokenBal = 0;
        
        if (STATE.tokenAddress) {
            tokenBal = await getTokenBalance(connection, masterKeypair.publicKey, STATE.tokenAddress);
        }
        
        const estTxs = Math.floor(solBal / (STATE.maxBuyAmount + STATE.priorityFee + 0.001));
        
        bot.sendMessage(chatId,
            `📊 *Bot Dashboard*\n\n` +
            `💰 *Balances*\n` +
            `SOL: \`${solBal.toFixed(4)}\`\n` +
            `Token: \`${tokenBal}\`\n\n` +
            `💼 *Wallet Pool*\n` +
            `Total: \`${walletPool.size.toLocaleString()}\` | Mode: *${STATE.useWalletPool ? 'ON' : 'OFF'}*\n` +
            `Concurrency: \`${STATE.batchConcurrency}\` | Per Cycle: \`${STATE.walletsPerCycle}\`\n\n` +
            `⚙️ *Config*\n` +
            `Strategy: *${STATE.strategy}*\n` +
            `Provider: *${STATE.swapProvider}* | DEX: *${STATE.targetDex}*\n` +
            `Token: \`${STATE.tokenAddress || 'Not Set'}\`\n` +
            `Buy: \`${STATE.minBuyAmount} - ${STATE.maxBuyAmount}\` SOL\n` +
            `Fee: \`${STATE.priorityFee}\` | Slip: \`${STATE.slippage}%\`\n` +
            `Jitter: \`${STATE.jitterPercentage}%\` | Delay: \`${STATE.intervalBetweenActions / 1000}s\`\n` +
            `Cycles: \`${STATE.numberOfCycles}\` | Sync: \`${STATE.maxSimultaneousBuys}/${STATE.maxSimultaneousSells}\`\n\n` +
            `🛡️ Engine: ${STATE.running ? '🟢 ONLINE' : '🔴 OFFLINE'}\n` +
            `🔁 Est. Max Swaps: \`${estTxs}\``,
            { parse_mode: 'Markdown' }
        );
    } catch (e) {
        logger.error(`[Dashboard] Error: ${e.message}`);
        bot.sendMessage(chatId, `⚠️ Could not fetch status: ${e.message}`, { parse_mode: 'Markdown' }).catch(() => {});
    }
}

// ─────────────────────────────────────────────
// 🎛️ Telegram UI: Show Wallet
// ─────────────────────────────────────────────
function showWallet(chatId) {
    if (!masterKeypair) {
        return bot.sendMessage(chatId, `❌ No wallet loaded.`, { parse_mode: 'Markdown' });
    }
    const addr = masterKeypair.publicKey.toBase58();
    bot.sendMessage(chatId, 
        `📜 *Master Wallet*\n\`${addr}\`\n\n[View on Solscan](https://solscan.io/account/${addr})`, 
        { parse_mode: 'Markdown' }
    );
}

// ─────────────────────────────────────────────
// 💬 Interactive Prompt Helper
// ─────────────────────────────────────────────
function promptSetting(chatId, prompt, callback) {
    const cid = chatId.toString();
    clearSession(cid);
    
    bot.sendMessage(chatId, prompt, { 
        parse_mode: "Markdown", 
        reply_markup: { force_reply: true, selective: true } 
    }).catch(() => {});
    
    const timeout = setTimeout(() => {
        if (userSessions.has(cid)) {
            userSessions.delete(cid);
            bot.sendMessage(chatId, "⏰ Prompt timed out. Try again.", { parse_mode: 'Markdown' }).catch(() => {});
        }
    }, 60000);
    
    userSessions.set(cid, { 
        action: 'prompt', 
        timeout, 
        callback, 
        created: Date.now() 
    });
}

// ─────────────────────────────────────────────
// ⚡ Rate Limiting
// ─────────────────────────────────────────────
const lastCommandTime = new Map();
function isRateLimited(chatId) {
    const cid = chatId.toString();
    const now = Date.now();
    const last = lastCommandTime.get(cid) || 0;
    
    if (now - last < 500) return true;
    lastCommandTime.set(cid, now);
    return false;
}

// ─────────────────────────────────────────────
// 🎮 Telegram Callback Handler (All Buttons)
// ─────────────────────────────────────────────
bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const action = callbackQuery.data;

    // Auth check
    if (!isAdmin(chatId)) {
        return bot.answerCallbackQuery(callbackQuery.id, { 
            text: "⛔ Unauthorized", 
            show_alert: true 
        });
    }
    
    // Rate limit
    if (isRateLimited(chatId)) {
        return bot.answerCallbackQuery(callbackQuery.id, { 
            text: "⏳ Please wait", 
            show_alert: false 
        });
    }
    
    bot.answerCallbackQuery(callbackQuery.id);
    
    // ───────── Engine Control ─────────
    if (action === 'start_cycles') {
        if (STATE.running) {
            return bot.sendMessage(chatId, `🔄 Already running! Stop first.`, { parse_mode: 'Markdown' });
        }
        startEngine(chatId);
    } 
    else if (action === 'stop_cycles') {
        STATE.running = false;
        bot.sendMessage(chatId, `🛑 Stopping after current action...`, { parse_mode: 'Markdown' });
    }
    
    // ───────── Navigation ─────────
    else if (action === 'strategies') showStrategyMenu(chatId);
    else if (action === 'settings') showSettingsMenu(chatId);
    else if (action === 'settings_basic') showBasicSettings(chatId);
    else if (action === 'settings_advanced') showAdvancedSettings(chatId);
    else if (action === 'settings_strat') showStrategyConfigMenu(chatId);
    else if (action === 'settings_jito') showJitoSettings(chatId);
    else if (action === 'stealth_settings') showStealthSettings(chatId);
    else if (action === 'show_realism') showRealismMenu(chatId);
    else if (action === 'wallet_pool') showWalletPoolMenu(chatId);
    else if (action === 'provider_settings') showProviderMenu(chatId);
    else if (action === 'select_dex') showDexMenu(chatId);
    else if (action === 'back_to_main') showMainMenu(chatId);
    else if (action === 'help') showHelp(chatId);
    else if (action === 'status') await showDashboard(chatId);
    else if (action === 'show_wallet') showWallet(chatId);
    
    // ───────── Strategy Selection ─────────
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
    
    // ───────── Provider & DEX ─────────
    else if (action === 'prov_tracker') {
        STATE.swapProvider = 'SOLANA_TRACKER';
        saveConfig();
        bot.sendMessage(chatId, `✅ Provider: *SolanaTracker*`, { parse_mode: 'Markdown' });
        showProviderMenu(chatId);
    }
    else if (action === 'prov_trade') {
        STATE.swapProvider = 'SOLANA_TRADE';
        saveConfig();
        bot.sendMessage(chatId, `✅ Provider: *SolanaTrade*`, { parse_mode: 'Markdown' });
        showProviderMenu(chatId);
    }
    else if (action.startsWith('dex_')) {
        STATE.targetDex = action.replace('dex_', '');
        saveConfig();
        bot.sendMessage(chatId, `✅ DEX: *${STATE.targetDex}*`, { parse_mode: 'Markdown' });
        showDexMenu(chatId);
    }
    
    // ───────── Basic Settings ─────────
    else if (action === 'set_token_address') {
        promptSetting(chatId, `Reply with *Token CA*:`, (val) => {
            try {
                STATE.tokenAddress = validateTokenAddress(val);
                saveConfig();
                bot.sendMessage(chatId, `✅ Token: \`${STATE.tokenAddress}\``, { parse_mode: "Markdown" });
            } catch (e) {
                bot.sendMessage(chatId, `❌ ${e.message}`, { parse_mode: "Markdown" });
            }
            showBasicSettings(chatId);
        });
    }
    else if (action === 'set_min_buy') {
        promptSetting(chatId, `Reply with *Min Buy* SOL (0.0005-10):`, (val) => {
            try { 
                STATE.minBuyAmount = validateNumber(val, 0.0005, 10, "Min Buy"); 
                saveConfig();
                bot.sendMessage(chatId, `✅ Min Buy: \`${STATE.minBuyAmount}\` SOL`); 
            } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showBasicSettings(chatId);
        });
    }
    else if (action === 'set_max_buy') {
        promptSetting(chatId, `Reply with *Max Buy* SOL (0.0005-10):`, (val) => {
            try { 
                STATE.maxBuyAmount = validateNumber(val, 0.0005, 10, "Max Buy");
                if (STATE.maxBuyAmount < STATE.minBuyAmount) throw new Error("Max must be >= Min");
                saveConfig();
                bot.sendMessage(chatId, `✅ Max Buy: \`${STATE.maxBuyAmount}\` SOL`); 
            } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showBasicSettings(chatId);
        });
    }
    else if (action === 'set_cycles') {
        promptSetting(chatId, `Reply with *Cycles* (1-1000):`, (val) => {
            try { 
                STATE.numberOfCycles = validateNumber(val, 1, 1000, "Cycles"); 
                saveConfig();
                bot.sendMessage(chatId, `✅ Cycles: \`${STATE.numberOfCycles}\``); 
            } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showBasicSettings(chatId);
        });
    }
    else if (action === 'set_jitter') {
        promptSetting(chatId, `Reply with *Jitter %* (0-100):`, (val) => {
            try { 
                STATE.jitterPercentage = validateNumber(val, 0, 100, "Jitter"); 
                saveConfig();
                bot.sendMessage(chatId, `✅ Jitter: \`${STATE.jitterPercentage}%\``); 
            } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showBasicSettings(chatId);
        });
    }
    else if (action === 'set_interval') {
        promptSetting(chatId, `Reply with *Delay* seconds (1-300):`, (val) => {
            try { 
                const sec = validateNumber(val, 1, 300, "Delay"); 
                STATE.intervalBetweenActions = sec * 1000;
                saveConfig();
                bot.sendMessage(chatId, `✅ Delay: \`${sec}s\``); 
            } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showBasicSettings(chatId);
        });
    }
    
    // ───────── Advanced Settings ─────────
    else if (action === 'set_fees') {
        promptSetting(chatId, `Reply with *Priority Fee* SOL (0-0.01):`, (val) => {
            try { 
                STATE.priorityFee = validateNumber(val, 0, 0.01, "Priority Fee"); 
                saveConfig();
                bot.sendMessage(chatId, `✅ Fee: \`${STATE.priorityFee}\` SOL`); 
            } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showAdvancedSettings(chatId);
        });
    }
    else if (action === 'set_slippage') {
        promptSetting(chatId, `Reply with *Slippage %* (0.5-50):`, (val) => {
            try { 
                STATE.slippage = validateNumber(val, 0.5, 50, "Slippage"); 
                saveConfig();
                bot.sendMessage(chatId, `✅ Slippage: \`${STATE.slippage}%\``); 
            } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showAdvancedSettings(chatId);
        });
    }
    else if (action === 'set_batch_concurrency') {
        promptSetting(chatId, `Reply with *Concurrency* (1-100):`, (val) => {
            STATE.batchConcurrency = Math.max(1, Math.min(100, parseInt(val)));
            saveConfig();
            bot.sendMessage(chatId, `✅ Concurrency: \`${STATE.batchConcurrency}\``);
            showAdvancedSettings(chatId);
        });
    }
    else if (action === 'set_wallets_per_cycle') {
        promptSetting(chatId, `Reply with *Wallets/Cycle* (1-1000):`, (val) => {
            STATE.walletsPerCycle = Math.max(1, parseInt(val));
            saveConfig();
            bot.sendMessage(chatId, `✅ Wallets/Cycle: \`${STATE.walletsPerCycle}\``);
            showAdvancedSettings(chatId);
        });
    }
    else if (action === 'set_sync') {
        promptSetting(chatId, `Reply with *Buys Sells* (e.g. \`2 2\`):`, (val) => {
            const parts = val.trim().split(/\s+/);
            if (parts.length >= 2) {
                STATE.maxSimultaneousBuys = parseInt(parts[0]);
                STATE.maxSimultaneousSells = parseInt(parts[1]);
                saveConfig();
                bot.sendMessage(chatId, `✅ Sync: \`${STATE.maxSimultaneousBuys}\` buys / \`${STATE.maxSimultaneousSells}\` sells`);
            } else { 
                bot.sendMessage(chatId, `❌ Format: \`buys sells\` (e.g. \`2 2\`)`); 
            }
            showAdvancedSettings(chatId);
        });
    }
    
    // ───────── Jito Settings ─────────
    else if (action === 'set_jito') { 
        STATE.useJito = !STATE.useJito; 
        saveConfig();
        bot.sendMessage(chatId, `✅ Jito: *${STATE.useJito ? 'ON' : 'OFF'}*`, { parse_mode: 'Markdown' }); 
        showJitoSettings(chatId); 
    }
    else if (action === 'set_jito_tip') {
        promptSetting(chatId, `Reply with *Jito Tip* SOL (0.00001-0.1):`, (val) => {
            try { 
                STATE.jitoTipAmount = validateNumber(val, 0.00001, 0.1, "Jito Tip"); 
                saveConfig();
                bot.sendMessage(chatId, `✅ Tip: \`${STATE.jitoTipAmount}\` SOL`); 
            } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showJitoSettings(chatId);
        });
    }
    
    // ───────── Realism Toggles ─────────
    else if (action === 'toggle_realism') { STATE.realismMode = !STATE.realismMode; saveConfig(); showRealismMenu(chatId); }
    else if (action === 'toggle_delays') { STATE.humanizedDelays = !STATE.humanizedDelays; saveConfig(); showRealismMenu(chatId); }
    else if (action === 'toggle_varslip') { STATE.variableSlippage = !STATE.variableSlippage; saveConfig(); showRealismMenu(chatId); }
    else if (action === 'toggle_poisson') { STATE.usePoissonTiming = !STATE.usePoissonTiming; saveConfig(); showRealismMenu(chatId); }
    else if (action === 'toggle_vol_curve') { STATE.useVolumeCurve = !STATE.useVolumeCurve; saveConfig(); showRealismMenu(chatId); }
    
    // ───────── Stealth Toggles ─────────
    else if (action === 'toggle_web_funding') { 
        STATE.useWebFunding = !STATE.useWebFunding; 
        saveConfig();
        bot.sendMessage(chatId, `✅ Web Funding: ${STATE.useWebFunding ? 'ON' : 'OFF'}`); 
        showStealthSettings(chatId); 
    }
    else if (action === 'toggle_stealth_level') { 
        STATE.fundingStealthLevel = STATE.fundingStealthLevel === 2 ? 1 : 2; 
        saveConfig();
        bot.sendMessage(chatId, `✅ Stealth: ${STATE.fundingStealthLevel === 2 ? 'Multi-hop' : 'Direct'}`); 
        showStealthSettings(chatId); 
    }
    else if (action === 'set_maker_depth') {
        promptSetting(chatId, `Reply with *Hop Depth* (1-5):`, (val) => {
            try { 
                STATE.makerFundingChainDepth = validateNumber(val, 1, 5, "Depth"); 
                saveConfig();
                bot.sendMessage(chatId, `✅ Depth: \`${STATE.makerFundingChainDepth}\``); 
            } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showStealthSettings(chatId);
        });
    }
    
    // ───────── Wallet Pool Operations ─────────
    else if (action === 'pool_generate') {
        promptSetting(chatId, `🔨 Generate wallets (e.g. \`1000\`, \`10000\`):\n\nCurrent pool: \`${walletPool.size}\``, async (val) => {
            const count = parseInt(val);
            if (isNaN(count) || count <= 0) return bot.sendMessage(chatId, `❌ Invalid number.`);
            if (count > 100000) return bot.sendMessage(chatId, `❌ Max 100,000 per generation.`);
            
            bot.sendMessage(chatId, `⏳ Generating ${count.toLocaleString()}...`);
            const generated = await walletPool.generateWallets?.(count) || count;
            
            bot.sendMessage(chatId, `✅ Generated *${generated.toLocaleString()}*!\nTotal: *${walletPool.size.toLocaleString()}*`, { parse_mode: 'Markdown' });
            showWalletPoolMenu(chatId);
        });
    }
    else if (action === 'pool_fund') {
        if (walletPool.size === 0) return bot.sendMessage(chatId, `❌ No wallets. Generate first!`);
        if (!masterKeypair) return bot.sendMessage(chatId, `❌ No master wallet.`);
        
        const estCost = (walletPool.size * STATE.fundAmountPerWallet).toFixed(2);
        promptSetting(chatId, `💰 *Fund Pool*\n\nWallets: \`${walletPool.size}\`\nPer wallet: \`${STATE.fundAmountPerWallet}\` SOL\n*Est. cost: \`${estCost}\` SOL*\n\nReply \`YES\` to confirm:`, async (val) => {
            if (val.toUpperCase() !== 'YES') return bot.sendMessage(chatId, `❌ Cancelled.`);
            
            await withRpcFallback(async (connection) => {
                bot.sendMessage(chatId, `💰 Funding ${walletPool.size} wallets...`);
                
                if (STATE.useWebFunding && STATE.fundingStealthLevel === 2) {
                    await fundWebSafe(connection, masterKeypair, walletPool.wallets || [], STATE.fundAmountPerWallet, chatId);
                } else {
                    await fundWalletsDirect(connection, masterKeypair, walletPool.wallets || [], STATE.fundAmountPerWallet, chatId);
                }
                bot.sendMessage(chatId, `✅ Funding complete.`);
                showWalletPoolMenu(chatId);
            });
        });
    }
    else if (action === 'pool_drain') {
        if (walletPool.size === 0) return bot.sendMessage(chatId, `❌ No wallets.`);
        if (!masterKeypair) return bot.sendMessage(chatId, `❌ No master wallet.`);
        
        promptSetting(chatId, `🔄 *Drain Pool*\n\nEmptying ${walletPool.size} wallets to master.\n\nReply \`YES\` to confirm:`, async (val) => {
            if (val.toUpperCase() !== 'YES') return bot.sendMessage(chatId, `❌ Cancelled.`);
            
            await withRpcFallback(async (connection) => {
                bot.sendMessage(chatId, `🔄 Draining ${walletPool.size} wallets...`);
                await drainWallets(connection, walletPool.wallets || [], masterKeypair.publicKey, chatId);
                showWalletPoolMenu(chatId);
            });
        });
    }
    else if (action === 'pool_scan') {
        if (walletPool.size === 0) return bot.sendMessage(chatId, `❌ No wallets.`);
        
        await withRpcFallback(async (connection) => {
            bot.sendMessage(chatId, `📊 Scanning ${walletPool.size} wallets...`);
            // Placeholder: implement scan logic based on your WalletPool API
            bot.sendMessage(chatId, `📊 Scan complete. (Implement scanBalances in walletManager.js)`);
            showWalletPoolMenu(chatId);
        });
    }
    else if (action === 'pool_toggle') { 
        STATE.useWalletPool = !STATE.useWalletPool; 
        saveConfig();
        bot.sendMessage(chatId, `✅ Pool Mode: *${STATE.useWalletPool ? 'ON' : 'OFF'}*`, { parse_mode: 'Markdown' }); 
        showWalletPoolMenu(chatId); 
    }
    else if (action === 'pool_clear') {
        if (walletPool.size === 0) return bot.sendMessage(chatId, `❌ Pool already empty.`);
        
        promptSetting(chatId, `⚠️ *Clear ALL ${walletPool.size} wallets?*\n\nReply \`DELETE\` to confirm:`, (val) => {
            if (val.toUpperCase() !== 'DELETE') return bot.sendMessage(chatId, `❌ Cancelled.`);
            walletPool.clearAll?.();
            bot.sendMessage(chatId, `✅ Pool cleared.`);
            showWalletPoolMenu(chatId);
        });
    }
    else if (action === 'set_fund_amount') {
        promptSetting(chatId, `Reply with *SOL per wallet* (e.g. \`0.01\`):`, (val) => {
            STATE.fundAmountPerWallet = parseFloat(val);
            saveConfig();
            bot.sendMessage(chatId, `✅ Fund Amt: \`${STATE.fundAmountPerWallet}\` SOL/wallet`, { parse_mode: 'Markdown' });
            showWalletPoolMenu(chatId);
        });
    }
    
    // ───────── Strategy Config Menus ─────────
    else if (action === 'conf_maker') {
        bot.sendMessage(chatId,
            `📈 *Maker Config*\n\n• Wallets to Generate: \`${STATE.makerWalletsToGenerate}\`\n• Funding Depth: \`${STATE.makerFundingChainDepth}\` hops`,
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '👥 Wallets', callback_data: 'set_maker_wallets' }],
                        [{ text: '🔗 Depth', callback_data: 'set_maker_depth' }],
                        [{ text: '🔙 Back', callback_data: 'settings_strat' }]
                    ]
                }
            }
        );
    }
    else if (action === 'set_maker_wallets') {
        promptSetting(chatId, `Reply with *Maker Wallets* (1-100):`, (val) => {
            try { 
                STATE.makerWalletsToGenerate = validateNumber(val, 1, 100, "Maker Wallets"); 
                saveConfig();
                bot.sendMessage(chatId, `✅ Maker Wallets: \`${STATE.makerWalletsToGenerate}\``); 
            } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showMakerConfig(chatId);
        });
    }
    
    // ───────── Chart Pattern ─────────
    else if (action === 'set_chart_pattern') {
        const patterns = ['ASCENDING', 'DESCENDING', 'SIDEWAYS', 'CUP_HANDLE', 'BREAKOUT'];
        bot.sendMessage(chatId, `📐 *Chart Pattern*\nCurrent: *${STATE.chartPattern}*`, {
            parse_mode: 'Markdown',
            reply_markup: { 
                inline_keyboard: [
                    ...patterns.map(p => [{ 
                        text: (STATE.chartPattern === p ? '✅ ' : '') + p, 
                        callback_data: `cpat_${p}` 
                    }]),
                    [{ text: '🔙 Back', callback_data: 'settings' }]
                ] 
            }
        });
    }
    else if (action.startsWith('cpat_')) { 
        STATE.chartPattern = action.replace('cpat_', ''); 
        saveConfig();
        bot.sendMessage(chatId, `✅ Pattern: *${STATE.chartPattern}*`, { parse_mode: 'Markdown' }); 
        showSettingsMenu(chatId); 
    }
    
    // ───────── Spam Config ─────────
    else if (action === 'conf_spam') {
        bot.sendMessage(chatId,
            `⚡ *Spam Config*\n\n• Micro-Buy: \`${STATE.spamMicroBuyAmount}\` SOL`,
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '⚡ Set Amount', callback_data: 'set_spam_amount' }],
                        [{ text: '🔙 Back', callback_data: 'settings_strat' }]
                    ]
                }
            }
        );
    }
    else if (action === 'set_spam_amount') {
        promptSetting(chatId, `Reply with *Spam Amount* SOL (0.00001-0.01):`, (val) => {
            try { 
                STATE.spamMicroBuyAmount = validateNumber(val, 0.00001, 0.01, "Spam Amount"); 
                saveConfig();
                bot.sendMessage(chatId, `✅ Spam: \`${STATE.spamMicroBuyAmount}\` SOL`); 
            } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showSpamConfig(chatId);
        });
    }
    
    // ───────── Whale/Holder Config ─────────
    else if (action === 'conf_whale') {
        bot.sendMessage(chatId,
            `🐋 *Whale & Holder Config*\n\n• Holders: \`${STATE.holderWallets}\`\n• Holder Buy: \`${STATE.holderBuyAmount}\` SOL\n• Whale Buy: \`${STATE.whaleBuyAmount}\` SOL\n• Whale Dump: \`${STATE.whaleSellPercent}%\``,
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '👥 Holders', callback_data: 'set_holder_wallets' }, { text: '💵 Holder Buy', callback_data: 'set_holder_buy' }],
                        [{ text: '🐋 Whale Buy', callback_data: 'set_whale_buy' }, { text: '🔴 Whale Dump', callback_data: 'set_whale_dump' }],
                        [{ text: '🔙 Back', callback_data: 'settings_strat' }]
                    ]
                }
            }
        );
    }
    else if (action === 'set_holder_wallets') {
        promptSetting(chatId, `Reply with *Holder Wallets* (1-1000):`, (val) => {
            try { 
                STATE.holderWallets = validateNumber(val, 1, 1000, "Holder Wallets"); 
                saveConfig();
                bot.sendMessage(chatId, `✅ Holders: \`${STATE.holderWallets}\``); 
            } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showWhaleHolderConfig(chatId);
        });
    }
    else if (action === 'set_holder_buy') {
        promptSetting(chatId, `Reply with *Holder Buy* SOL (0.001-1):`, (val) => {
            try { 
                STATE.holderBuyAmount = validateNumber(val, 0.001, 1, "Holder Buy"); 
                saveConfig();
                bot.sendMessage(chatId, `✅ Holder Buy: \`${STATE.holderBuyAmount}\` SOL`); 
            } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showWhaleHolderConfig(chatId);
        });
    }
    else if (action === 'set_whale_buy') {
        promptSetting(chatId, `Reply with *Whale Buy* SOL (0.1-100):`, (val) => {
            try { 
                STATE.whaleBuyAmount = validateNumber(val, 0.1, 100, "Whale Buy"); 
                saveConfig();
                bot.sendMessage(chatId, `✅ Whale Buy: \`${STATE.whaleBuyAmount}\` SOL`); 
            } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showWhaleHolderConfig(chatId);
        });
    }
    else if (action === 'set_whale_dump') {
        promptSetting(chatId, `Reply with *Whale Dump %* (1-100):`, (val) => {
            try { 
                STATE.whaleSellPercent = validateNumber(val, 1, 100, "Whale Dump %"); 
                saveConfig();
                bot.sendMessage(chatId, `✅ Whale Dump: \`${STATE.whaleSellPercent}%\``); 
            } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showWhaleHolderConfig(chatId);
        });
    }
    
    // ───────── Trending Config ─────────
    else if (action === 'conf_trending') {
        bot.sendMessage(chatId,
            `🔥 *Trending Config*\n\n• Mode: *${STATE.trendingMode}*\n• Intensity: \`${STATE.trendingIntensity}/10\``,
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
    else if (action === 'set_trending_mode') {
        const modes = ['VIRAL_PUMP', 'ORGANIC_GROWTH', 'FOMO_WAVE', 'LIQUIDITY_LADDER', 'WASH_TRADING'];
        bot.sendMessage(chatId, `🔥 *Trending Mode*\nCurrent: *${STATE.trendingMode}*`, {
            parse_mode: 'Markdown',
            reply_markup: { 
                inline_keyboard: [
                    ...modes.map(m => [{ 
                        text: (STATE.trendingMode === m ? '✅ ' : '') + m.replace(/_/g, ' '), 
                        callback_data: `tmode_${m}` 
                    }]),
                    [{ text: '🔙 Back', callback_data: 'settings' }]
                ] 
            }
        });
    }
    else if (action.startsWith('tmode_')) { 
        STATE.trendingMode = action.replace('tmode_', ''); 
        saveConfig();
        bot.sendMessage(chatId, `✅ Mode: *${STATE.trendingMode}*`, { parse_mode: 'Markdown' }); 
        showSettingsMenu(chatId); 
    }
    else if (action === 'set_trending_intensity') {
        promptSetting(chatId, `Reply with *Intensity* (1-10):`, (val) => {
            try { 
                STATE.trendingIntensity = validateNumber(val, 1, 10, "Intensity"); 
                saveConfig();
                bot.sendMessage(chatId, `✅ Intensity: \`${STATE.trendingIntensity}/10\``); 
            } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showSettingsMenu(chatId);
        });
    }
    
    // ───────── Manipulation Config ─────────
    else if (action === 'conf_manip') {
        bot.sendMessage(chatId,
            `🕸️ *Manipulation Config*\n\n• KOL Swarm: \`${STATE.kolRetailSwarmSize}\`\n• Airdrop Count: \`${STATE.airdropWalletCount}\`\n• Bull Trap Slip: \`${STATE.bullTrapSlippage}%\``,
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
    else if (action === 'set_kol_swarm') {
        promptSetting(chatId, `Reply with *KOL Swarm* (1-500):`, (val) => {
            try { 
                STATE.kolRetailSwarmSize = validateNumber(val, 1, 500, "KOL Swarm"); 
                saveConfig();
                bot.sendMessage(chatId, `✅ KOL Swarm: \`${STATE.kolRetailSwarmSize}\``); 
            } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showManipConfig(chatId);
        });
    }
    else if (action === 'set_airdrop_count') {
        promptSetting(chatId, `Reply with *Airdrop Count* (1-1000):`, (val) => {
            try { 
                STATE.airdropWalletCount = validateNumber(val, 1, 1000, "Airdrop Count"); 
                saveConfig();
                bot.sendMessage(chatId, `✅ Airdrop: \`${STATE.airdropWalletCount}\``); 
            } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showManipConfig(chatId);
        });
    }
    else if (action === 'set_bull_trap_slip') {
        promptSetting(chatId, `Reply with *Bull Trap Slip %* (1-50):`, (val) => {
            try { 
                STATE.bullTrapSlippage = validateNumber(val, 1, 50, "Bull Trap Slip"); 
                saveConfig();
                bot.sendMessage(chatId, `✅ Bull Trap Slip: \`${STATE.bullTrapSlippage}%\``); 
            } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showManipConfig(chatId);
        });
    }
});

// ─────────────────────────────────────────────
// 🚀 Bot Entry Point
// ─────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
    if (isAdmin(msg.chat.id)) {
        showMainMenu(msg.chat.id);
    } else {
        bot.sendMessage(msg.chat.id, "⛔ Unauthorized access.", { parse_mode: 'Markdown' });
    }
});

// Startup log
logger.info(`🚀 Volume Bot v3.0 started | Strategies: 14 | Pool: ${walletPool.size.toLocaleString()} wallets`);
logger.info(`🌐 RPC Endpoints: ${RPC_URLS.length} | Jito: ${STATE.useJito ? 'ON' : 'OFF'} | Stealth: Level ${STATE.fundingStealthLevel}`);

// Export for testing
export { STATE, walletPool, swap, sendSOL, getTokenBalance };
