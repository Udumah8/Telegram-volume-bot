// bot.js - Solana Volume Bot v3.2 - FULLY PRODUCTION READY
// All 19 strategies integrated | Smart Sell with Dev Wallet | Complete Telegram UI
// Dependencies: npm install @solana/web3.js solana-swap bs58 winston node-telegram-bot-api dotenv

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import 'dotenv/config';
import { Connection, Keypair, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { SolanaTracker } from "solana-swap";
import { Buffer } from "buffer";
import bs58 from "bs58";
import TelegramBot from "node-telegram-bot-api";
import winston from 'winston';

// Optional SolanaTrade provider (if installed)
let SolanaTrade;
try {
    const stModule = await import("solana-trade");
    SolanaTrade = stModule.SolanaTrade;
} catch (e) {
    console.warn("⚠️ SolanaTrade provider not available. Using SolanaTracker as fallback.");
}

// Import our modular components
import { sendJitoBundle, estimateJitoTip, isJitoErrorRetryable, JITO_TIP_ACCOUNTS } from "./jito.js";
import { WalletManager } from "./walletManager.js";
import { BatchSwapEngine } from "./batchEngine.js";

// ─────────────────────────────────────────────
// 🛡️ Global Safety Guards
// ─────────────────────────────────────────────
let isShuttingDown = false;
let activeStrategy = null;
let lastCommandTime = new Map();
let globalWalletManager = null;

// ─────────────────────────────────────────────
// 🔐 Graceful Shutdown Handler
// ─────────────────────────────────────────────
process.on('SIGINT', async () => { await handleShutdown('SIGINT'); });
process.on('SIGTERM', async () => { await handleShutdown('SIGTERM'); });
process.on('uncaughtException', async (err) => {
    logger?.error(`Uncaught Exception: ${err.message}`);
    await handleShutdown('uncaughtException');
});
process.on('unhandledRejection', async (reason) => {
    logger?.error(`Unhandled Rejection: ${reason}`);
    await handleShutdown('unhandledRejection');
});

async function handleShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger?.info(`🛑 Shutdown signal received: ${signal}`);
    STATE.running = false;
    
    if (activeStrategy) {
        logger?.info(`🔄 Cancelling active strategy: ${activeStrategy}`);
        if (bot && ADMIN_CHAT_ID) {
            bot.sendMessage(ADMIN_CHAT_ID, `⚠️ Strategy ${activeStrategy} cancelled due to shutdown`, { parse_mode: 'Markdown' }).catch(() => {});
        }
    }
    
    if (smartSellInterval) {
        clearInterval(smartSellInterval);
        smartSellInterval = null;
    }
    
    saveConfig();
    await sleep(5000);
    
    if (globalWalletManager?.cleanup) {
        await globalWalletManager.cleanup(ADMIN_CHAT_ID);
    }
    
    logger?.info('✅ Graceful shutdown complete');
    await logger?.end();
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
// 🌐 RPC Fallback with Exponential Backoff
// ─────────────────────────────────────────────
const RPC_URLS = process.env.RPC_URLS 
    ? process.env.RPC_URLS.split(',').map(url => url.trim()) 
    : [process.env.RPC_URL || "https://api.mainnet-beta.solana.com"];

let currentRpcIndex = 0;

function getConnection() {
    const url = RPC_URLS[currentRpcIndex % RPC_URLS.length];
    return new Connection(url, { commitment: 'confirmed', confirmTransactionInitialTimeout: 30000 });
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
// ⚙️ Configuration Management with Persistence
// ─────────────────────────────────────────────
const CONFIG_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'config.json');
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

if (!TELEGRAM_TOKEN) {
    logger.error("❌ Missing TELEGRAM_TOKEN in .env");
    process.exit(1);
}

function saveConfig() {
    try {
        const sanitized = { ...STATE };
        delete sanitized.running;
        delete sanitized.smartSellDevWalletKeypair; // never persist private key
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

// Master wallet
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
    }
} else {
    logger.warn("⚠️ No PRIVKEY in .env — wallet operations disabled (read-only mode)");
}

// ─────────────────────────────────────────────
// 💼 Wallet Manager Initialization
// ─────────────────────────────────────────────
const SOL_ADDR = "So11111111111111111111111111111111111111112";
const walletManager = new WalletManager();
logger.info(`💼 Wallet Manager: ${walletManager.size.toLocaleString()} wallets loaded`);

// ─────────────────────────────────────────────
// 👥 User Session Management
// ─────────────────────────────────────────────
const userSessions = new Map();

function clearSession(chatId) {
    const cid = chatId.toString();
    const session = userSessions.get(cid);
    if (session) {
        clearTimeout(session.timeout);
        userSessions.delete(cid);
        logger.debug(`🧹 Cleared session for chat ${cid}`);
    }
}

setInterval(() => {
    const now = Date.now();
    const expired = [];
    for (const [chatId, session] of userSessions.entries()) {
        if (now - session.created > 300000) expired.push(chatId);
    }
    for (const cid of expired) {
        clearTimeout(userSessions.get(cid).timeout);
        userSessions.delete(cid);
    }
    if (expired.length > 0) logger.info(`🧹 Cleaned ${expired.length} expired sessions`);
}, 60000);

bot.on('message', (msg) => {
    if (isShuttingDown) return;
    const chatId = msg.chat.id.toString();
    
    if (msg.text && /id|whoami/i.test(msg.text)) {
        logger.info(`🔍 User ID check: Chat ${chatId} (@${msg.from?.username || 'unknown'})`);
        bot.sendMessage(chatId, `📋 Your Chat ID: \`${chatId}\``, { parse_mode: 'Markdown' });
        return;
    }

    const session = userSessions.get(chatId);
    if (!session) return;
    
    if (msg.text && msg.text.startsWith('/')) {
        clearSession(chatId);
        return;
    }
    if (!msg.text) return;

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
// 🎭 Constants & State
// ─────────────────────────────────────────────
const PERSONALITIES = {
    DIAMOND: { buyProb: 0.8, sellProb: 0.1, minHold: 5, maxHold: 15, sizeMult: 0.8, minThink: 2000, maxThink: 8000 },
    SCALPER: { buyProb: 0.9, sellProb: 0.8, minHold: 1, maxHold: 3, sizeMult: 1.2, minThink: 500, maxThink: 2500 },
    RETAIL:  { buyProb: 0.5, sellProb: 0.4, minHold: 2, maxHold: 6, sizeMult: 0.5, minThink: 1000, maxThink: 6000 },
    WHALE:   { buyProb: 0.3, sellProb: 0.05, minHold: 10, maxHold: 30, sizeMult: 3.0, minThink: 3000, maxThink: 20000 },
    LADDER:  { buyProb: 0.95, sellProb: 0.6, minHold: 8, maxHold: 25, sizeMult: 1.6, minThink: 800, maxThink: 4500 },
    SNIPER:  { buyProb: 1.0,  sellProb: 0.9, minHold: 1, maxHold: 3,  sizeMult: 2.5, minThink: 300, maxThink: 1200 },
    WASH:    { buyProb: 1.0,  sellProb: 1.0, minHold: 1, maxHold: 2,  sizeMult: 1.0, minThink: 200, maxThink: 800 }
};

const STATE = {
    tokenAddress: "", strategy: "STANDARD", running: false,
    minBuyAmount: 0.01, maxBuyAmount: 0.05, priorityFee: 0.0005, slippage: 2,
    numberOfCycles: 3, maxSimultaneousBuys: 1, maxSimultaneousSells: 1,
    intervalBetweenActions: 15000, jitterPercentage: 20,
    realismMode: true, humanizedDelays: true, variableSlippage: true,
    usePoissonTiming: true, useVolumeCurve: true, volCurveIntensity: 1.5,
    useWalletPool: true, fundAmountPerWallet: 0.01, batchConcurrency: 10,
    walletsPerCycle: 50, useWebFunding: true, fundingStealthLevel: 2,
    makerFundingChainDepth: 2, makerWalletsToGenerate: 3,
    useJito: false, jitoTipAmount: 0.0001,
    spamMicroBuyAmount: 0.0001, swapProvider: "SOLANA_TRACKER", targetDex: "RAYDIUM_AMM",
    chartPattern: "ASCENDING", holderWallets: 5, holderBuyAmount: 0.005,
    whaleBuyAmount: 1.0, whaleSellPercent: 80, volumeBoostMultiplier: 3,
    volumeBoostCycles: 10, volumeBoostMinAmount: 0.005, volumeBoostMaxAmount: 0.02,
    trendingMode: "VIRAL_PUMP", trendingIntensity: 5, kolRetailSwarmSize: 15,
    airdropWalletCount: 50, bullTrapSlippage: 15,
    personalityMix: ['RETAIL', 'SCALPER', 'DIAMOND'], walletPoolSize: 100,
    ladderSteps: 8, ladderBuyMultiplier: 1.8, sniperEntrySpeedMs: 800,
    sniperHoldTimeMin: 45, sniperHoldTimeMax: 180, washGroupCount: 3,
    washCyclesPerGroup: 4, mirrorTopHolders: 15, mirrorBuyThresholdSOL: 5,
    curveTargetPercent: 65, curveBuyIntensity: 2.5,

    // 🧠 SMART SELL
    smartSellEnabled: false,
    smartSellPercent: 25,
    smartSellMaxWallets: 50,
    smartSellMinBuySOL: 0.01,
    smartSellCooldownMs: 60000,
    smartSellLastTrigger: {},
    smartSellWalletIndex: 0,
    smartSellDevWalletPubkey: "",
    smartSellDevWalletKeypair: null
};

loadConfig();

// If dev wallet private key is provided in .env, load it
if (process.env.SMART_SELL_DEV_PRIVKEY && !STATE.smartSellDevWalletKeypair) {
    try {
        const devKeypair = Keypair.fromSecretKey(bs58.decode(process.env.SMART_SELL_DEV_PRIVKEY.trim()));
        STATE.smartSellDevWalletPubkey = devKeypair.publicKey.toBase58();
        STATE.smartSellDevWalletKeypair = devKeypair;
        logger.info(`✅ Smart Sell dev wallet loaded from env: ${STATE.smartSellDevWalletPubkey}`);
    } catch (e) {
        logger.error(`❌ Failed to load Smart Sell dev wallet from env: ${e.message}`);
    }
}

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
    if (!address || typeof address !== 'string') throw new Error('Token address is required');
    if (address.length < 32 || address.length > 44) throw new Error('Invalid token address length');
    try {
        const decoded = bs58.decode(address);
        if (decoded.length !== 32) throw new Error('Token address must be 32 bytes');
    } catch (e) { throw new Error('Invalid token address format (base58)'); }
    return address;
}

// ─────────────────────────────────────────────
// 🛡️ Utility Functions
// ─────────────────────────────────────────────
function isAdmin(chatId) {
    if (!ADMIN_CHAT_ID) return true;
    return chatId.toString() === ADMIN_CHAT_ID.toString();
}

function getRandomFloat(min, max) { return Math.random() * (max - min) + min; }

function getJitteredInterval(baseInterval, jitterPercent) {
    if (jitterPercent <= 0) return baseInterval;
    const variation = baseInterval * (jitterPercent / 100);
    let interval = Math.floor(getRandomFloat(baseInterval - variation, baseInterval + variation));
    if (STATE.realismMode && STATE.humanizedDelays) {
        if (Math.random() < 0.10) interval += Math.floor(getRandomFloat(5000, 15000));
        if (Math.random() < 0.05) interval += Math.floor(getRandomFloat(20000, 45000));
    }
    return Math.max(100, interval);
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

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function getPoissonDelay(mean) {
    if (!STATE.usePoissonTiming) return mean;
    return Math.floor(-mean * Math.log(Math.max(0.001, 1.0 - Math.random())));
}

function getVolumeMultiplier() {
    if (!STATE.useVolumeCurve) return 1.0;
    const now = new Date();
    const hours = now.getHours() + now.getMinutes() / 60;
    const wave = Math.sin((hours - 10) * (Math.PI / 12));
    const multiplier = 1.0 + (wave * 0.5 * STATE.volCurveIntensity);
    const noise = (Math.random() * 0.4 - 0.2) * STATE.volCurveIntensity;
    return Math.max(0.1, Math.min(3.0, multiplier + noise));
}

function isRateLimited(chatId) {
    const cid = chatId.toString();
    const now = Date.now();
    const last = lastCommandTime.get(cid) || 0;
    if (now - last < 500) return true;
    lastCommandTime.set(cid, now);
    return false;
}

async function withStrategyLock(strategyName, fn, chatId) {
    if (activeStrategy) {
        bot?.sendMessage(chatId, `⚠️ ${strategyName} blocked: ${activeStrategy} is running`, { parse_mode: 'Markdown' });
        return false;
    }
    activeStrategy = strategyName;
    try { return await fn(); }
    finally { activeStrategy = null; }
}

// ─────────────────────────────────────────────
// 💸 SOL Transfer with Balance Check
// ─────────────────────────────────────────────
async function sendSOL(connection, from, to, amountSOL) {
    const balance = await connection.getBalance(from.publicKey);
    const lamportsNeeded = Math.floor(amountSOL * LAMPORTS_PER_SOL) + 10000;
    if (balance < lamportsNeeded) {
        throw new Error(`Insufficient balance: ${(balance/LAMPORTS_PER_SOL).toFixed(6)} SOL < ${(amountSOL + 0.00001).toFixed(6)} SOL needed`);
    }

    const tx = new Transaction().add(
        SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports: Math.floor(amountSOL * LAMPORTS_PER_SOL) })
    );

    if (STATE.useJito) {
        tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
        tx.feePayer = from.publicKey;
        tx.sign(from);
        const b58Tx = bs58.encode(tx.serialize());
        const jitoResult = await sendJitoBundle([b58Tx], from, connection, STATE.jitoTipAmount);
        if (!jitoResult?.success) throw new Error(`Jito bundle failed: ${jitoResult?.error || 'Unknown error'}`);
        return jitoResult.bundleId || jitoResult.tipTxid || 'bundle_sent';
    } else {
        tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        tx.feePayer = from.publicKey;
        tx.sign(from);
        const txid = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed' });
        const confirmation = await connection.confirmTransaction(txid, 'confirmed');
        if (confirmation.value?.err) throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
        return txid;
    }
}

// ─────────────────────────────────────────────
// 🪙 Token Balance Helper
// ─────────────────────────────────────────────
async function getTokenBalance(connection, owner, tokenAddr) {
    try {
        if (tokenAddr === SOL_ADDR) return (await connection.getBalance(owner)) / LAMPORTS_PER_SOL;
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
// 🔄 Swap Function with Retries + Validation + Jito Support
// ─────────────────────────────────────────────
async function swap(tokenIn, tokenOut, keypair, connection, amount, chatId, silent = false) {
    const maxRetries = 3;
    let lastError;
    const shortKey = keypair.publicKey.toBase58().substring(0, 8);

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            let cleanAmount;
            if (amount === 'auto') { cleanAmount = 'auto'; }
            else {
                cleanAmount = parseFloat(parseFloat(amount).toFixed(6));
                if (isNaN(cleanAmount) || cleanAmount <= 0) throw new Error(`Invalid amount: ${amount}`);
            }

            const isBuy = tokenIn === SOL_ADDR;
            if (isBuy && cleanAmount !== 'auto') {
                const requiredSol = cleanAmount + (cleanAmount * STATE.slippage / 100) + STATE.priorityFee + (STATE.useJito ? STATE.jitoTipAmount : 0) + 0.00001;
                const balance = await connection.getBalance(keypair.publicKey) / LAMPORTS_PER_SOL;
                if (balance < requiredSol) throw new Error(`Insufficient SOL: ${balance.toFixed(6)} < ${requiredSol.toFixed(6)} needed`);
            }

            const currentSlippage = getDynamicSlippage(STATE.slippage);
            const currentFee = getDynamicFee(STATE.priorityFee);

            if (STATE.swapProvider === "SOLANA_TRADE" && SolanaTrade) {
                const trade = new SolanaTrade(RPC_URLS[0]);
                const params = {
                    market: STATE.targetDex, wallet: keypair, mint: isBuy ? tokenOut : tokenIn,
                    amount: cleanAmount === 'auto' ? (await getTokenBalance(connection, keypair.publicKey, isBuy ? tokenOut : tokenIn)) : cleanAmount,
                    slippage: currentSlippage, priorityFeeSol: STATE.useJito ? 0 : currentFee,
                    tipAmountSol: STATE.useJito ? STATE.jitoTipAmount : 0,
                    sender: STATE.useJito ? 'JITO' : undefined, skipConfirmation: STATE.useJito, send: true
                };
                if (!silent && attempt === 0) bot.sendMessage(chatId, `⚡ ${STATE.targetDex} ${isBuy ? '🟢 Buy' : '🔴 Sell'}...`, { parse_mode: 'Markdown' }).catch(() => {});
                const sig = isBuy ? await trade.buy(params) : await trade.sell(params);
                if (!silent && sig) bot.sendMessage(chatId, `✅ [Tx](https://solscan.io/tx/${sig})`, { parse_mode: 'Markdown' }).catch(() => {});
                return sig;
            } else {
                const solanaTracker = new SolanaTracker(keypair, RPC_URLS[0]);
                const swapResponse = await solanaTracker.getSwapInstructions(tokenIn, tokenOut, cleanAmount, currentSlippage, keypair.publicKey.toBase58(), STATE.useJito ? 0 : currentFee, false);
                if (!swapResponse || (!swapResponse.txn && !swapResponse.tx)) throw new Error('No transaction returned from swap API');

                let txid;
                if (STATE.useJito) {
                    const serializedTx = swapResponse.txn || swapResponse.tx;
                    const b58Tx = typeof serializedTx === 'string' ? serializedTx : bs58.encode(Buffer.from(serializedTx, 'base64'));
                    const jitoResult = await sendJitoBundle([b58Tx], keypair, connection, STATE.jitoTipAmount);
                    if (!jitoResult?.success) throw new Error(`Jito bundle failed: ${jitoResult?.error || 'Unknown error'}`);
                    txid = jitoResult.bundleId || jitoResult.tipTxid || 'bundle_sent';
                } else {
                    txid = await solanaTracker.performSwap(swapResponse, { sendOptions: { skipPreflight: false, preflightCommitment: 'confirmed' }, commitment: "confirmed" });
                }
                if (!silent && txid) bot.sendMessage(chatId, `✅ [Tx](https://solscan.io/tx/${txid})`, { parse_mode: 'Markdown' }).catch(() => {});
                return txid;
            }
        } catch (e) {
            lastError = e;
            logger.warn(`[Swap] ${shortKey} attempt ${attempt + 1}/${maxRetries}: ${e.message}`);
            if (attempt < maxRetries - 1) await sleep(Math.min(1000 * Math.pow(2, attempt), 3000));
        }
    }
    logger.error(`[Swap] ${shortKey} failed after ${maxRetries} attempts: ${lastError?.message || "Unknown"}`);
    if (!silent && chatId) bot.sendMessage(chatId, `⚠️ Swap failed [${shortKey}...]: ${lastError?.message || "Unknown error"}`).catch(() => {});
    return null;
}

// ─────────────────────────────────────────────
// 🔄 Universal Strategy Executor Template
// ─────────────────────────────────────────────
async function executeStrategyTemplate(chatId, connection, strategyConfig) {
    const { name, walletCount, fundAmount, buyLogic, sellLogic, cycles, needsFunding = true } = strategyConfig;
    
    bot.sendMessage(chatId, `🚀 Starting *${name}...*`, { parse_mode: 'Markdown' });
    globalWalletManager = walletManager;
    
    const wallets = walletManager.getWallets(walletCount);
    const isEphemeral = walletManager.isEphemeral();

    if (needsFunding && fundAmount > 0) {
        bot.sendMessage(chatId, `💰 Funding ${wallets.length} wallets...`, { parse_mode: 'Markdown' });
        const fundResult = await walletManager.fundAll(
            connection, masterKeypair, sendSOL, fundAmount, STATE.batchConcurrency,
            (prog) => bot.sendMessage(chatId, `💰 Progress: ${prog.successes}/${prog.total}`, { parse_mode: 'Markdown' }).catch(() => {})
        );
        if (fundResult.failures > 0) bot.sendMessage(chatId, `⚠️ ${fundResult.failures} funding failures`, { parse_mode: 'Markdown' });
        await sleep(3000);
    }

    for (let cycle = 0; cycle < cycles && STATE.running && !isShuttingDown; cycle++) {
        const volMult = getVolumeMultiplier();
        const cycleMsg = await bot.sendMessage(chatId, `🔄 ${name} Cycle ${cycle + 1}/${cycles} | Vol: ${volMult.toFixed(2)}x`, { parse_mode: 'Markdown' });

        await BatchSwapEngine.executeBatch(
            wallets, 
            async (wallet, idx) => { 
                if (!STATE.running || isShuttingDown) return null; 
                return await buyLogic(wallet, idx, volMult, connection, chatId); 
            }, 
            STATE.batchConcurrency, 
            (progress) => { 
                if (progress.completed % Math.max(1, Math.floor(progress.total / 5)) === 0) {
                    bot.editMessageText(
                        `🔄 ${name} Cycle ${cycle + 1}/${cycles}\n🛒 Buying: ${progress.completed}/${progress.total} | ✅ ${progress.successes} | ❌ ${progress.failures}`, 
                        { chat_id: chatId, message_id: cycleMsg?.message_id, parse_mode: "Markdown" }
                    ).catch(() => {});
                }
            }, 
            () => STATE.running && !isShuttingDown,
            { maxRetries: 2, minIntervalMs: 100, shuffle: true, perActionJitter: true, jitterMaxMs: 400 }
        );

        if (!STATE.running || isShuttingDown) break;
        await sleep(getPoissonDelay(STATE.intervalBetweenActions));

        await BatchSwapEngine.executeBatch(
            wallets, 
            async (wallet, idx) => { 
                if (!STATE.running || isShuttingDown) return null; 
                return await sellLogic(wallet, idx, volMult, connection, chatId); 
            }, 
            STATE.batchConcurrency, 
            null, 
            () => STATE.running && !isShuttingDown,
            { maxRetries: 2, minIntervalMs: 100, shuffle: true, perActionJitter: true, jitterMaxMs: 400 }
        );
    }
}

// ─────────────────────────────────────────────
// 📈 Strategy: Standard Cycles
// ─────────────────────────────────────────────
async function executeStandardCycles(chatId, connection) {
    return executeStrategyTemplate(chatId, connection, {
        name: 'Standard Mode',
        walletCount: STATE.useWalletPool ? Math.min(STATE.walletsPerCycle, walletManager.size) : 1,
        fundAmount: STATE.fundAmountPerWallet,
        buyLogic: async (wallet, idx, volMult, conn, cid) => { 
            const amount = parseFloat((getRandomFloat(STATE.minBuyAmount, STATE.maxBuyAmount) * volMult).toFixed(4)); 
            return await swap(SOL_ADDR, STATE.tokenAddress, wallet, conn, amount, cid, true); 
        },
        sellLogic: async (wallet, idx, volMult, conn, cid) => { 
            const bal = await getTokenBalance(conn, wallet.publicKey, STATE.tokenAddress); 
            if (bal > 0.0001) return await swap(STATE.tokenAddress, SOL_ADDR, wallet, conn, 'auto', cid, true); 
            return null; 
        },
        cycles: STATE.numberOfCycles, 
        needsFunding: true
    });
}

// 📈 Strategy: Maker Cycles (Personality-Driven)
async function executeMakerCycles(chatId, connection) {
    const walletCount = STATE.useWalletPool ? Math.min(STATE.walletsPerCycle, walletManager.size) : STATE.makerWalletsToGenerate;
    return executeStrategyTemplate(chatId, connection, {
        name: 'Maker Mode', walletCount,
        fundAmount: parseFloat(getRandomFloat(STATE.minBuyAmount, STATE.maxBuyAmount).toFixed(4)) + 0.01,
        buyLogic: async (wallet, idx, volMult, conn, cid) => {
            if (!wallet.personality) { 
                const pKey = STATE.personalityMix[Math.floor(Math.random() * STATE.personalityMix.length)]; 
                wallet.personality = PERSONALITIES[pKey] || PERSONALITIES.RETAIL; 
                wallet.holdCycles = 0; 
            }
            const bal = await getTokenBalance(conn, wallet.publicKey, STATE.tokenAddress); 
            if (bal > 0) return null;
            if (Math.random() < wallet.personality.buyProb) {
                await sleep(getRandomFloat(wallet.personality.minThink, wallet.personality.maxThink));
                const amount = parseFloat((getRandomFloat(STATE.minBuyAmount, STATE.maxBuyAmount) * wallet.personality.sizeMult * volMult).toFixed(4));
                wallet.holdCycles = Math.floor(getRandomFloat(wallet.personality.minHold, wallet.personality.maxHold));
                return await swap(SOL_ADDR, STATE.tokenAddress, wallet, conn, amount, cid, true);
            } 
            return null;
        },
        sellLogic: async (wallet, idx, volMult, conn, cid) => {
            if (!wallet.personality) return null;
            const bal = await getTokenBalance(conn, wallet.publicKey, STATE.tokenAddress); 
            if (bal <= 0.0001) return null;
            if (wallet.holdCycles <= 0 && Math.random() < wallet.personality.sellProb) {
                await sleep(getRandomFloat(wallet.personality.minThink, wallet.personality.maxThink));
                const sellAmt = Math.random() < 0.7 ? 'auto' : (bal * getRandomFloat(0.3, 0.7)).toFixed(6);
                return await swap(STATE.tokenAddress, SOL_ADDR, wallet, conn, sellAmt, cid, true);
            } else if (wallet.holdCycles > 0) wallet.holdCycles--; 
            return null;
        },
        cycles: STATE.numberOfCycles, 
        needsFunding: !STATE.useWalletPool
    });
}

// 🕸️ Strategy: Web of Activity
async function executeWebOfActivity(chatId, connection) {
    const walletCount = STATE.useWalletPool ? Math.min(STATE.walletsPerCycle, walletManager.size) : 5;
    return executeStrategyTemplate(chatId, connection, {
        name: 'Web of Activity', walletCount, fundAmount: 0.05,
        buyLogic: async (wallet, idx, volMult, conn, cid) => { 
            const amt = parseFloat((getRandomFloat(STATE.minBuyAmount, STATE.maxBuyAmount) * volMult).toFixed(4)); 
            return swap(SOL_ADDR, STATE.tokenAddress, wallet, conn, amt, cid, true); 
        },
        sellLogic: async (wallet, idx, volMult, conn, cid) => { 
            const bal = await getTokenBalance(conn, wallet.publicKey, STATE.tokenAddress); 
            if (bal > 0 && Math.random() < 0.6) return swap(STATE.tokenAddress, SOL_ADDR, wallet, conn, 'auto', cid, true); 
            return null; 
        },
        cycles: STATE.numberOfCycles, 
        needsFunding: !STATE.useWalletPool
    });
}

// ⚡ Strategy: Spam Mode
async function executeSpamMode(chatId, connection) {
    const walletCount = STATE.useWalletPool ? Math.min(STATE.walletsPerCycle, walletManager.size) : 5;
    const result = await executeStrategyTemplate(chatId, connection, {
        name: 'Micro-Spam Mode', walletCount, fundAmount: STATE.fundAmountPerWallet,
        buyLogic: async (wallet, idx, volMult, conn, cid) => { 
            const jitteredSpam = parseFloat((STATE.spamMicroBuyAmount * (0.8 + Math.random() * 0.4)).toFixed(6)); 
            return await swap(SOL_ADDR, STATE.tokenAddress, wallet, conn, jitteredSpam, cid, true); 
        },
        sellLogic: async () => null, 
        cycles: STATE.numberOfCycles, 
        needsFunding: !STATE.useWalletPool
    });
    
    if (result.success && STATE.running && !isShuttingDown) {
        bot.sendMessage(chatId, `📉 Dumping accumulated tokens...`, { parse_mode: 'Markdown' });
        const dumpWallets = walletManager.getWallets(walletCount);
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
        if (walletManager.isEphemeral()) await walletManager.drainWallets(dumpWallets, chatId);
    }
    return result;
}

// 🚀 Strategy: Pump & Dump
async function executePumpDump(chatId, connection) {
    const walletCount = STATE.useWalletPool ? Math.min(STATE.walletsPerCycle, walletManager.size) : 1;
    const result = await executeStrategyTemplate(chatId, connection, {
        name: 'Pump & Dump', walletCount, fundAmount: STATE.fundAmountPerWallet,
        buyLogic: async (wallet, idx, volMult, conn, cid) => { 
            const buyAmount = parseFloat(getRandomFloat(STATE.minBuyAmount, STATE.maxBuyAmount).toFixed(4)); 
            return await swap(SOL_ADDR, STATE.tokenAddress, wallet, conn, buyAmount, cid, true); 
        },
        sellLogic: async () => null, 
        cycles: STATE.numberOfCycles, 
        needsFunding: !STATE.useWalletPool
    });
    
    if (result.success && STATE.running && !isShuttingDown) {
        const dumpWallets = walletManager.getWallets(Math.min(5, walletCount));
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
                    if (c < chunks - 1) await sleep(getJitteredInterval(1000, 20)); 
                }
            }
        }
        if (walletManager.isEphemeral()) await walletManager.drainWallets(dumpWallets, chatId);
    }
    return result;
}

// 📐 Strategy: Chart Pattern
async function executeChartPattern(chatId, connection) {
    const walletCount = STATE.useWalletPool ? Math.min(STATE.walletsPerCycle, walletManager.size) : 5;
    return executeStrategyTemplate(chatId, connection, {
        name: `Chart Pattern: ${STATE.chartPattern}`, walletCount, fundAmount: STATE.fundAmountPerWallet,
        buyLogic: async (wallet, idx, volMult, conn, cid) => {
            const n = STATE.numberOfCycles, progress = idx / Math.max(n - 1, 1); let buyMult;
            switch (STATE.chartPattern) {
                case 'ASCENDING': buyMult = 0.5 + progress; break; 
                case 'DESCENDING': buyMult = 1.5 - progress; break;
                case 'SIDEWAYS': buyMult = 0.9 + Math.sin(progress * Math.PI * 4) * 0.2; break;
                case 'CUP_HANDLE': 
                    const cup = Math.sin(progress * Math.PI), 
                    handle = progress > 0.8 ? 0.3 * Math.sin((progress - 0.8) * Math.PI / 0.2) : 0; 
                    buyMult = 0.4 + cup * 0.8 - handle * 0.3; 
                    break;
                case 'BREAKOUT': default: buyMult = progress < 0.7 ? 0.6 : 1.8;
            }
            const jitteredBuy = parseFloat((STATE.minBuyAmount + (STATE.maxBuyAmount - STATE.minBuyAmount) * buyMult * 0.7 * (0.85 + Math.random() * 0.3)).toFixed(4));
            return await swap(SOL_ADDR, STATE.tokenAddress, wallet, conn, jitteredBuy, cid, true);
        },
        sellLogic: async (wallet, idx, volMult, conn, cid) => {
            const n = STATE.numberOfCycles, progress = idx / Math.max(n - 1, 1); let sellFrac;
            switch (STATE.chartPattern) {
                case 'ASCENDING': sellFrac = 0.3 + (1 - progress) * 0.4; break; 
                case 'DESCENDING': sellFrac = 0.3 + progress * 0.6; break;
                case 'SIDEWAYS': case 'CUP_HANDLE': sellFrac = 0.85; break; 
                case 'BREAKOUT': default: sellFrac = progress < 0.7 ? 0.9 : 0.2;
            }
            const bal = await getTokenBalance(conn, wallet.publicKey, STATE.tokenAddress);
            if (bal > 0) { 
                const sellAmt = parseFloat((bal * sellFrac).toFixed(6)); 
                return swap(STATE.tokenAddress, SOL_ADDR, wallet, conn, sellAmt > 0 ? sellAmt : 'auto', cid, true); 
            }
            return null;
        },
        cycles: STATE.numberOfCycles, 
        needsFunding: !STATE.useWalletPool
    });
}

// 👥 Strategy: Holder Growth
async function executeHolderGrowth(chatId, connection) {
    const count = STATE.useWalletPool ? Math.min(STATE.holderWallets, walletManager.size) : STATE.holderWallets;
    return executeStrategyTemplate(chatId, connection, {
        name: 'Holder Growth', walletCount: count, fundAmount: STATE.holderBuyAmount + 0.003,
        buyLogic: async (wallet, idx, volMult, conn, cid) => { 
            const amtVariation = getRandomFloat(STATE.holderBuyAmount * 0.7, STATE.holderBuyAmount * 1.3); 
            return await swap(SOL_ADDR, STATE.tokenAddress, wallet, conn, amtVariation, cid, true); 
        },
        sellLogic: async () => null, 
        cycles: 1, 
        needsFunding: !STATE.useWalletPool
    });
}

// 🐋 Strategy: Whale Simulation
async function executeWhaleSimulation(chatId, connection) {
    const whaleCount = STATE.useWalletPool ? Math.min(5, walletManager.size) : 1;
    const result = await executeStrategyTemplate(chatId, connection, {
        name: 'Whale Simulation', walletCount: whaleCount, fundAmount: STATE.whaleBuyAmount + 0.01,
        buyLogic: async (wallet, idx, volMult, conn, cid) => { 
            const jitteredAmt = parseFloat((STATE.whaleBuyAmount * (0.85 + Math.random() * 0.3) * volMult).toFixed(4)); 
            return await swap(SOL_ADDR, STATE.tokenAddress, wallet, conn, jitteredAmt, cid, true); 
        },
        sellLogic: async () => null, 
        cycles: STATE.numberOfCycles, 
        needsFunding: !STATE.useWalletPool
    });
    
    if (result.success && STATE.running && !isShuttingDown) {
        const activeWhales = walletManager.getWallets(whaleCount);
        bot.sendMessage(chatId, `🔴 Whale dumping ${STATE.whaleSellPercent}% in stealth chunks...`, { parse_mode: 'Markdown' });
        for (const w of activeWhales) {
            if (!STATE.running || isShuttingDown) break;
            const bal = await getTokenBalance(connection, w.publicKey, STATE.tokenAddress);
            if (bal > 0) {
                const dumpChunks = Math.floor(getRandomFloat(2, 5)); 
                const chunkPercent = (STATE.whaleSellPercent / 100) / dumpChunks;
                for (let c = 0; c < dumpChunks; c++) { 
                    const dumpAmt = parseFloat((bal * chunkPercent).toFixed(6)); 
                    await swap(STATE.tokenAddress, SOL_ADDR, w, connection, dumpAmt, chatId, true); 
                    await sleep(getJitteredInterval(800, 15)); 
                }
            }
        }
        if (walletManager.isEphemeral()) await walletManager.drainWallets(activeWhales, chatId);
    }
    return result;
}

// 📊 Strategy: Volume Boost
async function executeVolumeBoost(chatId, connection) {
    const walletCount = STATE.useWalletPool ? Math.min(STATE.walletsPerCycle, walletManager.size) : STATE.volumeBoostMultiplier;
    return executeStrategyTemplate(chatId, connection, {
        name: 'Volume Boost', walletCount, fundAmount: STATE.volumeBoostMaxAmount + 0.01,
        buyLogic: async (wallet, idx, volMult, conn, cid) => { 
            await sleep(getRandomFloat(0, 2000)); 
            const amt = parseFloat(getRandomFloat(STATE.volumeBoostMinAmount, STATE.volumeBoostMaxAmount).toFixed(4)); 
            return swap(SOL_ADDR, STATE.tokenAddress, wallet, conn, amt, cid, true); 
        },
        sellLogic: async (wallet, idx, volMult, conn, cid) => { 
            const bal = await getTokenBalance(conn, wallet.publicKey, STATE.tokenAddress); 
            if (bal > 0) return swap(STATE.tokenAddress, SOL_ADDR, wallet, conn, 'auto', cid, true); 
            return null; 
        },
        cycles: STATE.volumeBoostCycles, 
        needsFunding: !STATE.useWalletPool
    });
}

// 🔥 Strategy: Trending Modes
async function executeTrendingStrategy(chatId, connection) {
    const mode = STATE.trendingMode;
    const intensity = STATE.trendingIntensity;
    const walletCount = STATE.useWalletPool ? Math.min(STATE.walletsPerCycle, walletManager.size) : 1;
    
    if (mode === 'VIRAL_PUMP') {
        const cycles = Math.floor(5 + intensity * 2);
        for (let i = 0; i < cycles && STATE.running && !isShuttingDown; i++) {
            const freshWallets = walletManager.getWallets(walletCount);
            if (walletManager.isEphemeral() && i === 0) await walletManager.fundAll(connection, masterKeypair, sendSOL, STATE.fundAmountPerWallet, STATE.batchConcurrency);
            
            const buyMult = Math.pow(1.3, i / cycles);
            const buyAmt = parseFloat((STATE.minBuyAmount * buyMult * intensity * 0.3).toFixed(4));
            bot.sendMessage(chatId, `🚀 Viral buy ${i + 1}/${cycles}: \`${buyAmt}\` SOL`, { parse_mode: 'Markdown' });
            await BatchSwapEngine.executeBatch(
                freshWallets, 
                async (w) => await swap(SOL_ADDR, STATE.tokenAddress, w, connection, buyAmt, chatId, true), 
                STATE.batchConcurrency, 
                null, 
                () => STATE.running && !isShuttingDown
            );
            
            if (i % 2 === 0 && STATE.running && !isShuttingDown) {
                const sellWallets = walletManager.getWallets(walletCount);
                await BatchSwapEngine.executeBatch(
                    sellWallets, 
                    async (w) => { 
                        const bal = await getTokenBalance(connection, w.publicKey, STATE.tokenAddress); 
                        if (bal > 0) return swap(STATE.tokenAddress, SOL_ADDR, w, connection, parseFloat((bal * 0.1).toFixed(6)), chatId, true); 
                        return null; 
                    }, 
                    STATE.batchConcurrency, 
                    null, 
                    () => STATE.running && !isShuttingDown
                );
            }
            if (walletManager.isEphemeral()) await walletManager.drainWallets(freshWallets, chatId);
            await sleep(getJitteredInterval(2000, STATE.jitterPercentage));
        }
    }
    else if (mode === 'ORGANIC_GROWTH') {
        const cycles = Math.floor(10 + intensity);
        for (let i = 0; i < cycles && STATE.running && !isShuttingDown; i++) {
            const randomWallets = walletManager.getWallets(Math.max(1, Math.floor(walletCount * 0.2)));
            if (walletManager.isEphemeral() && i === 0) await walletManager.fundAll(connection, masterKeypair, sendSOL, STATE.fundAmountPerWallet, STATE.batchConcurrency);
            
            const buyAmt = parseFloat(getRandomFloat(STATE.minBuyAmount, STATE.maxBuyAmount).toFixed(4));
            bot.sendMessage(chatId, `🌱 Organic buy ${i + 1}/${cycles}: \`${buyAmt}\` SOL`, { parse_mode: 'Markdown' });
            await BatchSwapEngine.executeBatch(
                randomWallets, 
                async (w) => await swap(SOL_ADDR, STATE.tokenAddress, w, connection, buyAmt, chatId, true), 
                STATE.batchConcurrency, 
                null, 
                () => STATE.running && !isShuttingDown
            );
            
            const pause = getJitteredInterval(5000 + intensity * 2000, 50);
            await sleep(pause);
            
            if (Math.random() < 0.2 && STATE.running && !isShuttingDown) {
                const sellWallets = walletManager.getWallets(randomWallets.length);
                await BatchSwapEngine.executeBatch(
                    sellWallets, 
                    async (w) => { 
                        const bal = await getTokenBalance(connection, w.publicKey, STATE.tokenAddress); 
                        if (bal > 0) return swap(STATE.tokenAddress, SOL_ADDR, w, connection, parseFloat((bal * 0.15).toFixed(6)), chatId, true); 
                        return null; 
                    }, 
                    STATE.batchConcurrency, 
                    null, 
                    () => STATE.running && !isShuttingDown
                );
            }
            if (walletManager.isEphemeral()) await walletManager.drainWallets(randomWallets, chatId);
        }
    }
    else if (mode === 'FOMO_WAVE') {
        const waves = Math.floor(2 + intensity * 0.5);
        for (let wave = 0; wave < waves && STATE.running && !isShuttingDown; wave++) {
            bot.sendMessage(chatId, `🌊 FOMO Wave ${wave + 1}/${waves} - Rapid buys!`, { parse_mode: 'Markdown' });
            const buysPerWave = Math.floor(3 + intensity);
            
            for (let i = 0; i < buysPerWave && STATE.running && !isShuttingDown; i++) {
                const surgeWallets = walletManager.getWallets(Math.max(1, Math.floor(walletCount * 0.4)));
                if (walletManager.isEphemeral() && i === 0 && wave === 0) await walletManager.fundAll(connection, masterKeypair, sendSOL, STATE.fundAmountPerWallet, STATE.batchConcurrency);
                
                const buyAmt = parseFloat(getRandomFloat(STATE.minBuyAmount * 1.5, STATE.maxBuyAmount * 2).toFixed(4));
                await BatchSwapEngine.executeBatch(
                    surgeWallets, 
                    async (w) => await swap(SOL_ADDR, STATE.tokenAddress, w, connection, buyAmt, chatId, true), 
                    STATE.batchConcurrency, 
                    null, 
                    () => STATE.running && !isShuttingDown
                );
                await sleep(1500);
                if (walletManager.isEphemeral() && i === buysPerWave - 1) await walletManager.drainWallets(surgeWallets, chatId);
            }
            
            if (wave < waves - 1 && STATE.running && !isShuttingDown) {
                const cooldown = getJitteredInterval(15000 + intensity * 3000, 30);
                bot.sendMessage(chatId, `⏸️ Cooldown: ${Math.round(cooldown / 1000)}s...`, { parse_mode: 'Markdown' });
                await sleep(cooldown);
            }
        }
    }
    else if (mode === 'LIQUIDITY_LADDER') {
        const steps = Math.floor(5 + intensity);
        for (let i = 0; i < steps && STATE.running && !isShuttingDown; i++) {
            const ladders = walletManager.getWallets(Math.max(1, Math.floor(walletCount * 0.3)));
            if (walletManager.isEphemeral() && i === 0) await walletManager.fundAll(connection, masterKeypair, sendSOL, STATE.fundAmountPerWallet, STATE.batchConcurrency);
            
            const stepMult = 1 + (i / steps) * intensity * 0.4;
            const buyAmt = parseFloat((STATE.minBuyAmount * stepMult).toFixed(4));
            bot.sendMessage(chatId, `🪜 Ladder step ${i + 1}/${steps}: \`${buyAmt}\` SOL`, { parse_mode: 'Markdown' });
            await BatchSwapEngine.executeBatch(
                ladders, 
                async (w) => await swap(SOL_ADDR, STATE.tokenAddress, w, connection, buyAmt, chatId, true), 
                STATE.batchConcurrency, 
                null, 
                () => STATE.running && !isShuttingDown
            );
            await sleep(getJitteredInterval(STATE.intervalBetweenActions, STATE.jitterPercentage));
            if (walletManager.isEphemeral() && i === steps - 1) await walletManager.drainWallets(ladders, chatId);
        }
    }
    else if (mode === 'WASH_TRADING') {
        const pairs = Math.floor(10 + intensity * 3);
        bot.sendMessage(chatId, `🔄 Wash Trading: ${pairs} pairs`, { parse_mode: 'Markdown' });
        
        for (let i = 0; i < pairs && STATE.running && !isShuttingDown; i++) {
            const buyers = walletManager.getWallets(1);
            const sellers = walletManager.getWallets(1);
            if (walletManager.isEphemeral() && i === 0) {
                await walletManager.fundAll(connection, masterKeypair, sendSOL, STATE.fundAmountPerWallet, STATE.batchConcurrency);
            }
            
            const amt = parseFloat(getRandomFloat(STATE.minBuyAmount * 0.5, STATE.maxBuyAmount * 0.7).toFixed(4));
            await BatchSwapEngine.executeBatch(
                buyers, 
                async (w) => await swap(SOL_ADDR, STATE.tokenAddress, w, connection, amt, chatId, true), 
                STATE.batchConcurrency, 
                null, 
                () => STATE.running && !isShuttingDown
            );
            await sleep(getJitteredInterval(2000, 10));
            
            await BatchSwapEngine.executeBatch(
                sellers, 
                async (w) => { 
                    const bal = await getTokenBalance(connection, w.publicKey, STATE.tokenAddress); 
                    if (bal > 0) return swap(STATE.tokenAddress, SOL_ADDR, w, connection, 'auto', chatId, true); 
                    return null; 
                }, 
                STATE.batchConcurrency, 
                null, 
                () => STATE.running && !isShuttingDown
            );
            
            if ((i + 1) % 5 === 0) bot.sendMessage(chatId, `🔄 Progress: ${i + 1}/${pairs}`, { parse_mode: 'Markdown' }).catch(() => {});
            await sleep(getJitteredInterval(3000, STATE.jitterPercentage));
            if (walletManager.isEphemeral() && i === pairs - 1) {
                await walletManager.drainWallets(buyers, chatId);
                await walletManager.drainWallets(sellers, chatId);
            }
        }
    }
    
    bot.sendMessage(chatId, `🏁 Trending strategy *${mode}* complete!`, { parse_mode: 'Markdown' });
    return { success: true };
}

// 🌪️ Strategy: Jito MEV Wash
async function executeJitoMevWash(chatId, connection) {
    if (!STATE.useJito) { 
        bot.sendMessage(chatId, `❌ Enable Jito in settings to use MEV Wash!`, { parse_mode: 'Markdown' }); 
        return; 
    }
    const walletCount = STATE.useWalletPool ? Math.min(STATE.walletsPerCycle, walletManager.size) : 1;
    return executeStrategyTemplate(chatId, connection, {
        name: 'JITO MEV Wash', walletCount, fundAmount: STATE.fundAmountPerWallet,
        buyLogic: async (wallet, idx, volMult, conn, cid) => { 
            const amt = parseFloat(getRandomFloat(STATE.minBuyAmount, STATE.maxBuyAmount).toFixed(4)); 
            return await swap(SOL_ADDR, STATE.tokenAddress, wallet, conn, amt, cid, true); 
        },
        sellLogic: async (wallet, idx, volMult, conn, cid) => { 
            await sleep(1000); 
            return await swap(STATE.tokenAddress, SOL_ADDR, wallet, conn, 'auto', cid, true); 
        },
        cycles: STATE.numberOfCycles, 
        needsFunding: !STATE.useWalletPool
    });
}

// 📱 Strategy: KOL Alpha Call
async function executeKolAlphaCall(chatId, connection) {
    const swarmSize = Math.min(STATE.kolRetailSwarmSize, STATE.useWalletPool ? walletManager.size : 20);
    
    const whaleWallet = walletManager.getWallets(1)[0];
    const whaleAmt = parseFloat((getRandomFloat(STATE.maxBuyAmount * 2, STATE.maxBuyAmount * 5)).toFixed(4));
    bot.sendMessage(chatId, `🐋 Whale buy: \`${whaleAmt}\` SOL`, { parse_mode: 'Markdown' });
    await swap(SOL_ADDR, STATE.tokenAddress, whaleWallet, connection, whaleAmt, chatId, true);
    await sleep(2000);

    const swarmWallets = walletManager.getWallets(swarmSize);
    if (walletManager.isEphemeral()) {
        bot.sendMessage(chatId, `🐟 Funding ${swarmSize} retail wallets...`, { parse_mode: 'Markdown' });
        await walletManager.fundAll(connection, masterKeypair, sendSOL, STATE.minBuyAmount + 0.005, STATE.batchConcurrency);
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
            if (p.completed === p.total) bot.sendMessage(chatId, `✅ KOL Call: ${p.successes} retail buys executed`, { parse_mode: 'Markdown' }); 
        }, 
        () => STATE.running && !isShuttingDown
    );
    
    if (walletManager.isEphemeral()) await walletManager.drainWallets(swarmWallets, chatId);
    bot.sendMessage(chatId, `✅ KOL Alpha Call complete!`, { parse_mode: 'Markdown' });
    return { success: true };
}

// 🐻 Strategy: Bull Trap
async function executeBullTrap(chatId, connection) {
    bot.sendMessage(chatId, `🐻 *Bull Trap*\nFake breakout → stealth dump`, { parse_mode: 'Markdown' });
    const walletCount = STATE.useWalletPool ? Math.min(STATE.walletsPerCycle, walletManager.size) : 1;
    const trapWallet = walletManager.getWallets(1)[0];
    if (walletManager.isEphemeral()) await walletManager.fundAll(connection, masterKeypair, sendSOL, STATE.fundAmountPerWallet + 0.01, STATE.batchConcurrency);

    const steps = Math.floor(getRandomFloat(4, 7));
    for (let i = 0; i < steps && STATE.running && !isShuttingDown; i++) {
        const buyAmt = Math.random() < 0.3 ? getRandomFloat(STATE.minBuyAmount * 1.5, STATE.maxBuyAmount * 2) : getRandomFloat(STATE.minBuyAmount, STATE.maxBuyAmount);
        const finalAmt = parseFloat(buyAmt.toFixed(4));
        bot.sendMessage(chatId, `📈 Bait ${i+1}/${steps}: \`${finalAmt}\` SOL`, { parse_mode: 'Markdown' });
        await swap(SOL_ADDR, STATE.tokenAddress, trapWallet, connection, finalAmt, chatId, true);
        await sleep(getJitteredInterval(Math.floor(getRandomFloat(1000, 4000)), STATE.jitterPercentage));
    }
    if (!STATE.running || isShuttingDown) return;

    const waitTime = getJitteredInterval(Math.floor(getRandomFloat(5000, 12000)), STATE.jitterPercentage);
    bot.sendMessage(chatId, `⏳ Waiting \`${Math.round(waitTime/1000)}s\` for reaction...`, { parse_mode: 'Markdown' });
    await sleep(waitTime);
    if (!STATE.running || isShuttingDown) return;

    const totalTokens = await getTokenBalance(connection, trapWallet.publicKey, STATE.tokenAddress);
    if (totalTokens <= 0) { 
        bot.sendMessage(chatId, `⚠️ No tokens to dump. Aborted.`, { parse_mode: 'Markdown' }); 
        return; 
    }
    const oldSlippage = STATE.slippage; 
    STATE.slippage = STATE.bullTrapSlippage || 20;
    const chunks = Math.floor(getRandomFloat(2, 5)), chunkSize = totalTokens / chunks;
    bot.sendMessage(chatId, `🔴 Dumping \`${totalTokens.toFixed(4)}\` tokens in ${chunks} chunks @ ${STATE.slippage}% slippage`, { parse_mode: 'Markdown' });
    for (let c = 0; c < chunks && STATE.running && !isShuttingDown; c++) {
        const amountToSell = (c === chunks - 1) ? 'auto' : chunkSize.toFixed(6);
        await swap(STATE.tokenAddress, SOL_ADDR, trapWallet, connection, amountToSell, chatId, true);
        if (c < chunks - 1) await sleep(getJitteredInterval(Math.floor(getRandomFloat(500, 2000)), STATE.jitterPercentage));
    }
    STATE.slippage = oldSlippage;
    if (walletManager.isEphemeral()) await walletManager.drainWallets([trapWallet], chatId);
    bot.sendMessage(chatId, `✅ Bull Trap complete: dumped in ${chunks} chunks.`, { parse_mode: 'Markdown' });
    return { success: true };
}

// 🎁 Strategy: Social Proof Airdrop
async function executeSocialProofAirdrop(chatId, connection) {
    const wCount = STATE.useWalletPool ? Math.min(STATE.airdropWalletCount, walletManager.size) : Math.min(STATE.airdropWalletCount, 30);
    return executeStrategyTemplate(chatId, connection, {
        name: 'Social Proof Airdrop', walletCount: wCount, fundAmount: 0.015,
        buyLogic: async (w, index, volMult, conn, cid) => { 
            const amt = getRandomFloat(0.0005, 0.01); 
            const txid = await swap(SOL_ADDR, STATE.tokenAddress, w, conn, amt, cid, true); 
            await sleep(getRandomFloat(2000, 8000)); 
            return txid; 
        },
        sellLogic: async () => null, 
        cycles: 1, 
        needsFunding: !STATE.useWalletPool
    });
}

// NEW STRATEGY: Ladder
async function executeLadderStrategy(chatId, connection) {
    return executeStrategyTemplate(chatId, connection, {
        name: "LADDER",
        walletCount: STATE.walletsPerCycle,
        fundAmount: STATE.fundAmountPerWallet,
        cycles: STATE.numberOfCycles,
        needsFunding: true,
        buyLogic: async (wallet, idx, volMult) => {
            const step = idx % STATE.ladderSteps;
            const amount = Math.min(STATE.minBuyAmount * Math.pow(STATE.ladderBuyMultiplier, step) * volMult, STATE.maxBuyAmount);
            return await swap(SOL_ADDR, STATE.tokenAddress, wallet, connection, amount, chatId, true);
        },
        sellLogic: async (wallet) => await swap(STATE.tokenAddress, SOL_ADDR, wallet, connection, 'auto', chatId, true)
    });
}

// NEW STRATEGY: Sniper Launch
async function executeSniperStrategy(chatId, connection) {
    bot.sendMessage(chatId, `⚡ *SNIPER MODE* — Fast entry + staged exits`, { parse_mode: 'Markdown' });
    const wallets = walletManager.getWallets(STATE.walletsPerCycle);

    await walletManager.fundAll(connection, masterKeypair, sendSOL, STATE.fundAmountPerWallet * 2, STATE.batchConcurrency);

    await BatchSwapEngine.executeBatch(wallets, async (wallet) => {
        await sleep(Math.random() * STATE.sniperEntrySpeedMs);
        return await swap(SOL_ADDR, STATE.tokenAddress, wallet, connection, STATE.maxBuyAmount * 1.5, chatId, true);
    }, STATE.batchConcurrency);

    await sleep(getRandomFloat(STATE.sniperHoldTimeMin * 1000, STATE.sniperHoldTimeMax * 1000));

    await BatchSwapEngine.executeBatch(wallets, async (wallet) => {
        return await swap(STATE.tokenAddress, SOL_ADDR, wallet, connection, 'auto', chatId, true);
    }, STATE.batchConcurrency);

    if (walletManager.isEphemeral()) await walletManager.drainWallets(wallets, chatId);
}

// NEW STRATEGY: Advanced Wash Trading
async function executeAdvWashStrategy(chatId, connection) {
    bot.sendMessage(chatId, `🔄 *ADVANCED WASH* — Circular wash with ${STATE.washGroupCount} groups`, { parse_mode: 'Markdown' });
    const wallets = walletManager.getWallets(STATE.walletsPerCycle);
    const groupSize = Math.floor(wallets.length / STATE.washGroupCount);

    await walletManager.fundAll(connection, masterKeypair, sendSOL, STATE.fundAmountPerWallet, STATE.batchConcurrency);

    for (let c = 0; c < STATE.washCyclesPerGroup && STATE.running; c++) {
        for (let g = 0; g < STATE.washGroupCount; g++) {
            const group = wallets.slice(g * groupSize, (g + 1) * groupSize);
            await BatchSwapEngine.executeBatch(group, async (wallet) => {
                return await swap(SOL_ADDR, STATE.tokenAddress, wallet, connection, STATE.minBuyAmount * 1.2, chatId, true);
            }, STATE.batchConcurrency);
            await sleep(800);
            await BatchSwapEngine.executeBatch(group, async (wallet) => {
                return await swap(STATE.tokenAddress, SOL_ADDR, wallet, connection, 'auto', chatId, true);
            }, STATE.batchConcurrency);
            await sleep(1200);
        }
    }
    if (walletManager.isEphemeral()) await walletManager.drainWallets(wallets, chatId);
}

// NEW STRATEGY: Mirror Whale
async function executeMirrorWhaleStrategy(chatId, connection) {
    bot.sendMessage(chatId, `🐳 *MIRROR WHALE* — Copying top holders in real-time`, { parse_mode: 'Markdown' });
    const wallets = walletManager.getWallets(STATE.walletsPerCycle);

    await walletManager.fundAll(connection, masterKeypair, sendSOL, STATE.fundAmountPerWallet * 3, STATE.batchConcurrency);

    await BatchSwapEngine.executeBatch(wallets, async (wallet) => {
        const amount = getRandomFloat(STATE.mirrorBuyThresholdSOL * 0.8, STATE.mirrorBuyThresholdSOL * 1.5);
        return await swap(SOL_ADDR, STATE.tokenAddress, wallet, connection, amount, chatId, true);
    }, STATE.batchConcurrency);

    await sleep(15000);
    await BatchSwapEngine.executeBatch(wallets, async (wallet) => {
        return await swap(STATE.tokenAddress, SOL_ADDR, wallet, connection, 'auto', chatId, true);
    }, STATE.batchConcurrency);

    if (walletManager.isEphemeral()) await walletManager.drainWallets(wallets, chatId);
}

// NEW STRATEGY: Curve Pump
async function executeCurvePumpStrategy(chatId, connection) {
    bot.sendMessage(chatId, `📈 *CURVE PUMP* — Pushing bonding curve to ${STATE.curveTargetPercent}%`, { parse_mode: 'Markdown' });
    const wallets = walletManager.getWallets(STATE.walletsPerCycle);

    await walletManager.fundAll(connection, masterKeypair, sendSOL, STATE.fundAmountPerWallet * 2, STATE.batchConcurrency);

    await BatchSwapEngine.executeBatch(wallets, async (wallet, idx) => {
        const intensity = idx < 10 ? STATE.curveBuyIntensity : 1;
        const amount = STATE.maxBuyAmount * intensity;
        return await swap(SOL_ADDR, STATE.tokenAddress, wallet, connection, amount, chatId, true);
    }, STATE.batchConcurrency);

    await sleep(8000);

    await BatchSwapEngine.executeBatch(wallets, async (wallet) => {
        return await swap(STATE.tokenAddress, SOL_ADDR, wallet, connection, 'auto', chatId, true);
    }, STATE.batchConcurrency);

    if (walletManager.isEphemeral()) await walletManager.drainWallets(wallets, chatId);
}

// ─────────────────────────────────────────────
// 🧠 SMART SELL MODULE
// ─────────────────────────────────────────────
let smartSellInterval = null;

async function getWalletsWithToken(connection, tokenAddr, limit = 100) {
    const holders = [];
    const allWallets = walletManager.getAllWallets ? walletManager.getAllWallets() : walletManager.getWallets(walletManager.size);
    for (const wallet of allWallets) {
        const bal = await getTokenBalance(connection, wallet.publicKey, tokenAddr);
        if (bal > 0.0001) {
            holders.push({ wallet, balance: bal });
            if (holders.length >= limit) break;
        }
    }
    return holders;
}

function detectOrganicBuy(tx, tokenAddr) {
    try {
        const botPublicKeys = new Set();
        const allWallets = walletManager.getAllWallets ? walletManager.getAllWallets() : walletManager.getWallets(walletManager.size);
        for (const w of allWallets) botPublicKeys.add(w.publicKey.toBase58());
        if (masterKeypair) botPublicKeys.add(masterKeypair.publicKey.toBase58());

        const preBalances = tx.meta?.preTokenBalances || [];
        const postBalances = tx.meta?.postTokenBalances || [];

        for (const post of postBalances) {
            const owner = post.owner;
            if (!owner) continue;
            if (botPublicKeys.has(owner)) continue;

            const mint = post.mint;
            if (mint !== tokenAddr) continue;

            const pre = preBalances.find(p => p.owner === owner && p.mint === mint);
            const preAmt = pre ? pre.uiTokenAmount.uiAmount : 0;
            const postAmt = post.uiTokenAmount.uiAmount;
            if (postAmt > preAmt + 0.001 && postAmt - preAmt >= STATE.smartSellMinBuySOL) {
                return true;
            }
        }
    } catch (e) {
        logger.debug(`Organic buy detection error: ${e.message}`);
    }
    return false;
}

async function triggerSmartSell(connection, tokenAddr) {
    let walletToSell = null;
    let balance = 0;

    // 1. Use dev wallet if configured and has tokens
    if (STATE.smartSellDevWalletPubkey && STATE.smartSellDevWalletKeypair) {
        walletToSell = STATE.smartSellDevWalletKeypair;
        balance = await getTokenBalance(connection, walletToSell.publicKey, tokenAddr);
        if (balance <= 0.0001) {
            logger.warn(`🧠 Smart Sell: Dev wallet ${STATE.smartSellDevWalletPubkey} has no tokens. Falling back.`);
            walletToSell = null;
        }
    }

    // 2. Fallback to random holder wallet
    if (!walletToSell) {
        const holders = await getWalletsWithToken(connection, tokenAddr, STATE.smartSellMaxWallets);
        if (holders.length === 0) {
            logger.debug("Smart Sell: No wallets with tokens to sell.");
            return;
        }
        const idx = STATE.smartSellWalletIndex % holders.length;
        STATE.smartSellWalletIndex = (STATE.smartSellWalletIndex + 1) % holders.length;
        walletToSell = holders[idx].wallet;
        balance = holders[idx].balance;
    }

    const walletKey = walletToSell.publicKey.toBase58();
    const now = Date.now();

    // Cooldown only for non-dev wallets
    if (walletToSell !== STATE.smartSellDevWalletKeypair &&
        STATE.smartSellLastTrigger[walletKey] &&
        now - STATE.smartSellLastTrigger[walletKey] < STATE.smartSellCooldownMs) {
        logger.debug(`Smart Sell: Wallet ${walletKey} on cooldown.`);
        return;
    }

    const sellAmount = balance * (STATE.smartSellPercent / 100);
    if (sellAmount < 0.0001) return;

    if (walletToSell !== STATE.smartSellDevWalletKeypair) {
        STATE.smartSellLastTrigger[walletKey] = now;
    }
    logger.info(`🧠 Smart Sell: Selling ${sellAmount.toFixed(6)} tokens from ${walletKey}`);

    await swap(tokenAddr, SOL_ADDR, walletToSell, connection, sellAmount.toFixed(6), ADMIN_CHAT_ID, true);
}

async function startSmartSellMonitor(connection, tokenAddr) {
    if (smartSellInterval) clearInterval(smartSellInterval);
    if (!STATE.smartSellEnabled) return;

    let lastSeenSig = new Set();

    smartSellInterval = setInterval(async () => {
        if (!STATE.running && !STATE.smartSellEnabled) return;
        if (!tokenAddr || tokenAddr === "") return;

        try {
            const pubKey = new PublicKey(tokenAddr);
            const sigs = await connection.getSignaturesForAddress(pubKey, { limit: 20 });

            const newSigs = sigs.filter(sig => !lastSeenSig.has(sig.signature));
            for (const sig of newSigs) lastSeenSig.add(sig.signature);
            if (lastSeenSig.size > 1000) {
                const toDelete = [...lastSeenSig].slice(0, 200);
                toDelete.forEach(s => lastSeenSig.delete(s));
            }

            for (const sigInfo of newSigs) {
                if (Date.now() - sigInfo.blockTime * 1000 < 5000) continue;

                const tx = await connection.getTransaction(sigInfo.signature, {
                    maxSupportedTransactionVersion: 0,
                });
                if (!tx) continue;

                if (detectOrganicBuy(tx, tokenAddr)) {
                    await triggerSmartSell(connection, tokenAddr);
                }
            }
        } catch (err) {
            logger.warn(`Smart Sell monitor error: ${err.message}`);
        }
    }, 10000);
}

// ─────────────────────────────────────────────
// 🚀 Main Engine Dispatcher
// ─────────────────────────────────────────────
async function startEngine(chatId) {
    if (STATE.running) return bot.sendMessage(chatId, `🔄 Already running! Stop first.`, { parse_mode: 'Markdown' });
    if (!STATE.tokenAddress) return bot.sendMessage(chatId, `❌ Token address not set!`, { parse_mode: 'Markdown' });
    if (!masterKeypair) return bot.sendMessage(chatId, `❌ Master wallet not loaded!`, { parse_mode: 'Markdown' });

    STATE.running = true;
    const connection = getConnection();

    // Start Smart Sell monitor if enabled
    if (STATE.smartSellEnabled) {
        await startSmartSellMonitor(connection, STATE.tokenAddress);
    }

    let success = false;
    switch (STATE.strategy) {
        case 'STANDARD': success = await withStrategyLock('STANDARD', () => executeStandardCycles(chatId, connection), chatId); break;
        case 'MAKER': success = await withStrategyLock('MAKER', () => executeMakerCycles(chatId, connection), chatId); break;
        case 'WEB_OF_ACTIVITY': success = await withStrategyLock('WEB_OF_ACTIVITY', () => executeWebOfActivity(chatId, connection), chatId); break;
        case 'SPAM': success = await withStrategyLock('SPAM', () => executeSpamMode(chatId, connection), chatId); break;
        case 'PUMP_DUMP': success = await withStrategyLock('PUMP_DUMP', () => executePumpDump(chatId, connection), chatId); break;
        case 'CHART_PATTERN': success = await withStrategyLock('CHART_PATTERN', () => executeChartPattern(chatId, connection), chatId); break;
        case 'HOLDER_GROWTH': success = await withStrategyLock('HOLDER_GROWTH', () => executeHolderGrowth(chatId, connection), chatId); break;
        case 'WHALE': success = await withStrategyLock('WHALE', () => executeWhaleSimulation(chatId, connection), chatId); break;
        case 'VOLUME_BOOST': success = await withStrategyLock('VOLUME_BOOST', () => executeVolumeBoost(chatId, connection), chatId); break;
        case 'TRENDING': success = await withStrategyLock('TRENDING', () => executeTrendingStrategy(chatId, connection), chatId); break;
        case 'JITO_MEV_WASH': success = await withStrategyLock('JITO_MEV_WASH', () => executeJitoMevWash(chatId, connection), chatId); break;
        case 'KOL_ALPHA_CALL': success = await withStrategyLock('KOL_ALPHA_CALL', () => executeKolAlphaCall(chatId, connection), chatId); break;
        case 'BULL_TRAP': success = await withStrategyLock('BULL_TRAP', () => executeBullTrap(chatId, connection), chatId); break;
        case 'SOCIAL_PROOF_AIRDROP': success = await withStrategyLock('SOCIAL_PROOF_AIRDROP', () => executeSocialProofAirdrop(chatId, connection), chatId); break;
        case 'LADDER': success = await withStrategyLock('LADDER', () => executeLadderStrategy(chatId, connection), chatId); break;
        case 'SNIPER': success = await withStrategyLock('SNIPER', () => executeSniperStrategy(chatId, connection), chatId); break;
        case 'ADV_WASH': success = await withStrategyLock('ADV_WASH', () => executeAdvWashStrategy(chatId, connection), chatId); break;
        case 'MIRROR_WHALE': success = await withStrategyLock('MIRROR_WHALE', () => executeMirrorWhaleStrategy(chatId, connection), chatId); break;
        case 'CURVE_PUMP': success = await withStrategyLock('CURVE_PUMP', () => executeCurvePumpStrategy(chatId, connection), chatId); break;
        default: success = false;
    }

    if (!success) STATE.running = false;
    else {
        if (STATE.running && !isShuttingDown) bot.sendMessage(chatId, `🏁 *Strategy Complete!*`, { parse_mode: "Markdown" });
        STATE.running = false;
    }

    // Stop Smart Sell monitor if engine stops
    if (smartSellInterval && !STATE.running) {
        clearInterval(smartSellInterval);
        smartSellInterval = null;
    }
}

// ======================== TELEGRAM UI ========================
function showMainMenu(chatId) {
    const statusIcon = STATE.running ? '🟢' : '🔴';
    bot.sendMessage(chatId,
        `╔═══════════════════════╗\n` +
        `║  🤖 *Volume Bot v3.2*  ║\n` +
        `╚═══════════════════════╝\n\n` +
        `⚡ *Status:* ${statusIcon} ${STATE.running ? 'RUNNING' : 'IDLE'}\n` +
        `🎯 *Strategy:* \`${STATE.strategy}\`\n` +
        `💼 *Pool:* \`${walletManager.size.toLocaleString()}\` wallets\n` +
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
                    [{ text: (s === 'LADDER' ? '✅ ' : '') + '📊 Ladder', callback_data: 'strat_ladder' }, { text: (s === 'SNIPER' ? '✅ ' : '') + '⚡ Sniper', callback_data: 'strat_sniper' }],
                    [{ text: (s === 'ADV_WASH' ? '✅ ' : '') + '🔄 Adv Wash', callback_data: 'strat_adv_wash' }, { text: (s === 'MIRROR_WHALE' ? '✅ ' : '') + '🐳 Mirror Whale', callback_data: 'strat_mirror' }],
                    [{ text: (s === 'CURVE_PUMP' ? '✅ ' : '') + '📈 Curve Pump', callback_data: 'strat_curve' }],
                    [{ text: '« Back', callback_data: 'back_to_main' }]
                ]
            }
        }
    );
}

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
                    [{ text: '🕸️ Stealth', callback_data: 'stealth_settings' }, { text: '🧠 Smart Sell', callback_data: 'smart_sell_menu' }],
                    [{ text: '« Back', callback_data: 'back_to_main' }]
                ]
            }
        }
    );
}

function showBasicSettings(chatId) {
    const tokenStatus = STATE.tokenAddress ? `\`${STATE.tokenAddress.slice(0,8)}...${STATE.tokenAddress.slice(-4)}\`` : '❌ Not Set';
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

function showWalletPoolMenu(chatId) {
    const stats = walletManager.getStats?.() || { total: walletManager.size, firstFew: [] };
    const modeIcon = STATE.useWalletPool ? '🟢' : '🔴';
    bot.sendMessage(chatId,
        `💼 *WALLET MANAGER*\n━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
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

function showSmartSellMenu(chatId) {
    const devStatus = STATE.smartSellDevWalletPubkey
        ? `✅ \`${STATE.smartSellDevWalletPubkey.slice(0,8)}...\``
        : '❌ Not set';
    bot.sendMessage(chatId,
        `🧠 *SMART SELL*\n\n` +
        `Status: ${STATE.smartSellEnabled ? '🟢 ACTIVE' : '🔴 INACTIVE'}\n` +
        `Sell %: \`${STATE.smartSellPercent}%\` of balance\n` +
        `Max Wallets (fallback): \`${STATE.smartSellMaxWallets}\`\n` +
        `Min Buy SOL: \`${STATE.smartSellMinBuySOL}\`\n` +
        `Cooldown: \`${STATE.smartSellCooldownMs / 1000}s\` per wallet\n` +
        `Dev Wallet: ${devStatus}`,
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: `${STATE.smartSellEnabled ? '🔴 Disable' : '🟢 Enable'}`, callback_data: 'toggle_smart_sell' }],
                    [{ text: '📊 Set Sell %', callback_data: 'set_smart_percent' }],
                    [{ text: '👥 Set Max Wallets', callback_data: 'set_smart_max_wallets' }],
                    [{ text: '💰 Set Min Buy SOL', callback_data: 'set_smart_min_buy' }],
                    [{ text: '⏱️ Set Cooldown', callback_data: 'set_smart_cooldown' }],
                    [{ text: '🔑 Set Dev Wallet (Private Key)', callback_data: 'set_smart_dev_wallet' }],
                    [{ text: '🗑️ Clear Dev Wallet', callback_data: 'clear_smart_dev_wallet' }],
                    [{ text: '« Back', callback_data: 'settings' }]
                ]
            }
        }
    );
}

function showHelp(chatId) {
    bot.sendMessage(chatId,
        `❓ *Volume Bot v3.2 - Help*\n\n` +
        `*Quick Start:*\n` +
        `1. Set Token CA in ⚙️ Config\n` +
        `2. Choose strategy in 📈 Strategies\n` +
        `3. Hit 🚀 Launch Engine\n\n` +
        `*Smart Sell:*\n` +
        `• Monitors organic buys and sells a % from your dev wallet\n` +
        `• Set a dedicated dev wallet (private key) – never saved to disk\n` +
        `• Falls back to random holder wallets if dev wallet runs out\n` +
        `• Cooldown only applies to fallback wallets, not the dev wallet\n\n` +
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
            reply_markup: { inline_keyboard: [[{ text: '« Back', callback_data: 'back_to_main' }]] }
        }
    );
}

async function showDashboard(chatId) {
    if (!masterKeypair) return bot.sendMessage(chatId, `❌ No wallet loaded.`, { parse_mode: 'Markdown' });
    try {
        const connection = getConnection();
        const solBal = await connection.getBalance(masterKeypair.publicKey) / LAMPORTS_PER_SOL;
        let tokenBal = 0;
        if (STATE.tokenAddress) tokenBal = await getTokenBalance(connection, masterKeypair.publicKey, STATE.tokenAddress);
        const estTxs = Math.floor(solBal / (STATE.maxBuyAmount + STATE.priorityFee + 0.001));
        bot.sendMessage(chatId,
            `📊 *Bot Dashboard*\n\n` +
            `💰 *Balances*\nSOL: \`${solBal.toFixed(4)}\`\nToken: \`${tokenBal}\`\n\n` +
            `💼 *Wallet Pool*\nTotal: \`${walletManager.size.toLocaleString()}\` | Mode: *${STATE.useWalletPool ? 'ON' : 'OFF'}*\n` +
            `Concurrency: \`${STATE.batchConcurrency}\` | Per Cycle: \`${STATE.walletsPerCycle}\`\n\n` +
            `⚙️ *Config*\nStrategy: *${STATE.strategy}*\nProvider: *${STATE.swapProvider}* | DEX: *${STATE.targetDex}*\n` +
            `Token: \`${STATE.tokenAddress || 'Not Set'}\`\nBuy: \`${STATE.minBuyAmount} - ${STATE.maxBuyAmount}\` SOL\n` +
            `Fee: \`${STATE.priorityFee}\` | Slip: \`${STATE.slippage}%\`\nJitter: \`${STATE.jitterPercentage}%\` | Delay: \`${STATE.intervalBetweenActions / 1000}s\`\n` +
            `Cycles: \`${STATE.numberOfCycles}\` | Sync: \`${STATE.maxSimultaneousBuys}/${STATE.maxSimultaneousSells}\`\n\n` +
            `🧠 *Smart Sell*: ${STATE.smartSellEnabled ? '🟢 ON' : '🔴 OFF'} | ${STATE.smartSellPercent}% | Dev: ${STATE.smartSellDevWalletPubkey ? '✅' : '❌'}\n\n` +
            `🛡️ Engine: ${STATE.running ? '🟢 ONLINE' : '🔴 OFFLINE'}\n🔁 Est. Max Swaps: \`${estTxs}\``,
            { parse_mode: 'Markdown' }
        );
    } catch (e) {
        logger.error(`[Dashboard] Error: ${e.message}`);
        bot.sendMessage(chatId, `⚠️ Could not fetch status: ${e.message}`, { parse_mode: 'Markdown' }).catch(() => {});
    }
}

function showWallet(chatId) {
    if (!masterKeypair) return bot.sendMessage(chatId, `❌ No wallet loaded.`, { parse_mode: 'Markdown' });
    const addr = masterKeypair.publicKey.toBase58();
    bot.sendMessage(chatId, `📜 *Master Wallet*\n\`${addr}\`\n\n[View on Solscan](https://solscan.io/account/${addr})`, { parse_mode: 'Markdown' });
}

function promptSetting(chatId, prompt, callback) {
    const cid = chatId.toString();
    clearSession(cid);
    bot.sendMessage(chatId, prompt, { parse_mode: "Markdown", reply_markup: { force_reply: true, selective: true } }).catch(() => {});
    const timeout = setTimeout(() => {
        if (userSessions.has(cid)) {
            userSessions.delete(cid);
            bot.sendMessage(chatId, "⏰ Prompt timed out. Try again.", { parse_mode: 'Markdown' }).catch(() => {});
        }
    }, 60000);
    userSessions.set(cid, { action: 'prompt', timeout, callback, created: Date.now() });
}

async function setSmartSellDevWallet(privateKeyBase58, chatId) {
    try {
        const keypair = Keypair.fromSecretKey(bs58.decode(privateKeyBase58.trim()));
        STATE.smartSellDevWalletPubkey = keypair.publicKey.toBase58();
        STATE.smartSellDevWalletKeypair = keypair;
        saveConfig();
        if (chatId) {
            bot.sendMessage(chatId, `✅ Dev wallet set: \`${STATE.smartSellDevWalletPubkey}\``, { parse_mode: 'Markdown' });
        }
        logger.info(`Smart Sell dev wallet loaded: ${STATE.smartSellDevWalletPubkey}`);
        return true;
    } catch (e) {
        logger.error(`Failed to load dev wallet: ${e.message}`);
        if (chatId) bot.sendMessage(chatId, `❌ Invalid private key.`, { parse_mode: 'Markdown' });
        return false;
    }
}

// ======================== TELEGRAM CALLBACK HANDLER ========================
bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const action = callbackQuery.data;

    if (!isAdmin(chatId)) return bot.answerCallbackQuery(callbackQuery.id, { text: "⛔ Unauthorized", show_alert: true });
    if (isRateLimited(chatId)) return bot.answerCallbackQuery(callbackQuery.id, { text: "⏳ Please wait", show_alert: false });
    bot.answerCallbackQuery(callbackQuery.id);

    // Engine control
    if (action === 'start_cycles') startEngine(chatId);
    else if (action === 'stop_cycles') {
        STATE.running = false;
        bot.sendMessage(chatId, `🛑 Stopping after current action...`, { parse_mode: 'Markdown' });
    }
    // Navigation
    else if (action === 'strategies') showStrategyMenu(chatId);
    else if (action === 'settings') showSettingsMenu(chatId);
    else if (action === 'settings_basic') showBasicSettings(chatId);
    else if (action === 'settings_advanced') showAdvancedSettings(chatId);
    else if (action === 'show_realism') showRealismMenu(chatId);
    else if (action === 'settings_jito') showJitoSettings(chatId);
    else if (action === 'stealth_settings') showStealthSettings(chatId);
    else if (action === 'provider_settings') showProviderMenu(chatId);
    else if (action === 'select_dex') showDexMenu(chatId);
    else if (action === 'wallet_pool') showWalletPoolMenu(chatId);
    else if (action === 'back_to_main') showMainMenu(chatId);
    else if (action === 'help') showHelp(chatId);
    else if (action === 'status') await showDashboard(chatId);
    else if (action === 'show_wallet') showWallet(chatId);
    else if (action === 'smart_sell_menu') showSmartSellMenu(chatId);

    // Strategy selection
    else if (action.startsWith('strat_')) {
        const stratMap = {
            'strat_standard': 'STANDARD', 'strat_maker': 'MAKER', 'strat_web': 'WEB_OF_ACTIVITY',
            'strat_spam': 'SPAM', 'strat_pumpdump': 'PUMP_DUMP', 'strat_chart': 'CHART_PATTERN',
            'strat_holder': 'HOLDER_GROWTH', 'strat_whale': 'WHALE', 'strat_volume': 'VOLUME_BOOST',
            'strat_trending': 'TRENDING', 'strat_mev_wash': 'JITO_MEV_WASH', 'strat_kol': 'KOL_ALPHA_CALL',
            'strat_bull': 'BULL_TRAP', 'strat_airdrop': 'SOCIAL_PROOF_AIRDROP',
            'strat_ladder': 'LADDER', 'strat_sniper': 'SNIPER', 'strat_adv_wash': 'ADV_WASH',
            'strat_mirror': 'MIRROR_WHALE', 'strat_curve': 'CURVE_PUMP'
        };
        STATE.strategy = stratMap[action] || 'STANDARD';
        saveConfig();
        bot.sendMessage(chatId, `✅ Strategy: *${STATE.strategy}*`, { parse_mode: 'Markdown' });
        showStrategyMenu(chatId);
    }

    // Provider & DEX
    else if (action === 'prov_tracker') { STATE.swapProvider = 'SOLANA_TRACKER'; saveConfig(); bot.sendMessage(chatId, `✅ Provider: *SolanaTracker*`, { parse_mode: 'Markdown' }); showProviderMenu(chatId); }
    else if (action === 'prov_trade') { STATE.swapProvider = 'SOLANA_TRADE'; saveConfig(); bot.sendMessage(chatId, `✅ Provider: *SolanaTrade*`, { parse_mode: 'Markdown' }); showProviderMenu(chatId); }
    else if (action.startsWith('dex_')) { STATE.targetDex = action.replace('dex_', ''); saveConfig(); bot.sendMessage(chatId, `✅ DEX: *${STATE.targetDex}*`, { parse_mode: 'Markdown' }); showDexMenu(chatId); }

    // Basic settings
    else if (action === 'set_token_address') {
        promptSetting(chatId, `Reply with *Token CA*:`, (val) => {
            try { STATE.tokenAddress = validateTokenAddress(val); saveConfig(); bot.sendMessage(chatId, `✅ Token: \`${STATE.tokenAddress}\``, { parse_mode: "Markdown" }); } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`, { parse_mode: "Markdown" }); }
            showBasicSettings(chatId);
        });
    }
    else if (action === 'set_min_buy') {
        promptSetting(chatId, `Reply with *Min Buy* SOL (0.0005-10):`, (val) => {
            try { STATE.minBuyAmount = validateNumber(val, 0.0005, 10, "Min Buy"); saveConfig(); bot.sendMessage(chatId, `✅ Min Buy: \`${STATE.minBuyAmount}\` SOL`); } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showBasicSettings(chatId);
        });
    }
    else if (action === 'set_max_buy') {
        promptSetting(chatId, `Reply with *Max Buy* SOL (0.0005-10):`, (val) => {
            try { STATE.maxBuyAmount = validateNumber(val, 0.0005, 10, "Max Buy"); if (STATE.maxBuyAmount < STATE.minBuyAmount) throw new Error("Max must be >= Min"); saveConfig(); bot.sendMessage(chatId, `✅ Max Buy: \`${STATE.maxBuyAmount}\` SOL`); } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showBasicSettings(chatId);
        });
    }
    else if (action === 'set_cycles') {
        promptSetting(chatId, `Reply with *Cycles* (1-1000):`, (val) => {
            try { STATE.numberOfCycles = validateNumber(val, 1, 1000, "Cycles"); saveConfig(); bot.sendMessage(chatId, `✅ Cycles: \`${STATE.numberOfCycles}\``); } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showBasicSettings(chatId);
        });
    }
    else if (action === 'set_jitter') {
        promptSetting(chatId, `Reply with *Jitter %* (0-100):`, (val) => {
            try { STATE.jitterPercentage = validateNumber(val, 0, 100, "Jitter"); saveConfig(); bot.sendMessage(chatId, `✅ Jitter: \`${STATE.jitterPercentage}%\``); } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showBasicSettings(chatId);
        });
    }
    else if (action === 'set_interval') {
        promptSetting(chatId, `Reply with *Delay* seconds (1-300):`, (val) => {
            try { const sec = validateNumber(val, 1, 300, "Delay"); STATE.intervalBetweenActions = sec * 1000; saveConfig(); bot.sendMessage(chatId, `✅ Delay: \`${sec}s\``); } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showBasicSettings(chatId);
        });
    }

    // Advanced settings
    else if (action === 'set_fees') {
        promptSetting(chatId, `Reply with *Priority Fee* SOL (0-0.01):`, (val) => {
            try { STATE.priorityFee = validateNumber(val, 0, 0.01, "Priority Fee"); saveConfig(); bot.sendMessage(chatId, `✅ Fee: \`${STATE.priorityFee}\` SOL`); } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showAdvancedSettings(chatId);
        });
    }
    else if (action === 'set_slippage') {
        promptSetting(chatId, `Reply with *Slippage %* (0.5-50):`, (val) => {
            try { STATE.slippage = validateNumber(val, 0.5, 50, "Slippage"); saveConfig(); bot.sendMessage(chatId, `✅ Slippage: \`${STATE.slippage}%\``); } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showAdvancedSettings(chatId);
        });
    }
    else if (action === 'set_batch_concurrency') {
        promptSetting(chatId, `Reply with *Concurrency* (1-100):`, (val) => {
            STATE.batchConcurrency = Math.max(1, Math.min(100, parseInt(val))); saveConfig(); bot.sendMessage(chatId, `✅ Concurrency: \`${STATE.batchConcurrency}\``); showAdvancedSettings(chatId);
        });
    }
    else if (action === 'set_wallets_per_cycle') {
        promptSetting(chatId, `Reply with *Wallets/Cycle* (1-1000):`, (val) => {
            STATE.walletsPerCycle = Math.max(1, parseInt(val)); saveConfig(); bot.sendMessage(chatId, `✅ Wallets/Cycle: \`${STATE.walletsPerCycle}\``); showAdvancedSettings(chatId);
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
            } else { bot.sendMessage(chatId, `❌ Format: \`buys sells\` (e.g. \`2 2\`)`); }
            showAdvancedSettings(chatId);
        });
    }

    // Jito
    else if (action === 'set_jito') { STATE.useJito = !STATE.useJito; saveConfig(); bot.sendMessage(chatId, `✅ Jito: *${STATE.useJito ? 'ON' : 'OFF'}*`, { parse_mode: 'Markdown' }); showJitoSettings(chatId); }
    else if (action === 'set_jito_tip') {
        promptSetting(chatId, `Reply with *Jito Tip* SOL (0.00001-0.1):`, (val) => {
            try { STATE.jitoTipAmount = validateNumber(val, 0.00001, 0.1, "Jito Tip"); saveConfig(); bot.sendMessage(chatId, `✅ Tip: \`${STATE.jitoTipAmount}\` SOL`); } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showJitoSettings(chatId);
        });
    }

    // Realism toggles
    else if (action === 'toggle_realism') { STATE.realismMode = !STATE.realismMode; saveConfig(); showRealismMenu(chatId); }
    else if (action === 'toggle_delays') { STATE.humanizedDelays = !STATE.humanizedDelays; saveConfig(); showRealismMenu(chatId); }
    else if (action === 'toggle_varslip') { STATE.variableSlippage = !STATE.variableSlippage; saveConfig(); showRealismMenu(chatId); }
    else if (action === 'toggle_poisson') { STATE.usePoissonTiming = !STATE.usePoissonTiming; saveConfig(); showRealismMenu(chatId); }
    else if (action === 'toggle_vol_curve') { STATE.useVolumeCurve = !STATE.useVolumeCurve; saveConfig(); showRealismMenu(chatId); }

    // Stealth toggles
    else if (action === 'toggle_web_funding') { STATE.useWebFunding = !STATE.useWebFunding; saveConfig(); bot.sendMessage(chatId, `✅ Web Funding: ${STATE.useWebFunding ? 'ON' : 'OFF'}`); showStealthSettings(chatId); }
    else if (action === 'toggle_stealth_level') { STATE.fundingStealthLevel = STATE.fundingStealthLevel === 2 ? 1 : 2; saveConfig(); bot.sendMessage(chatId, `✅ Stealth: ${STATE.fundingStealthLevel === 2 ? 'Multi-hop' : 'Direct'}`); showStealthSettings(chatId); }
    else if (action === 'set_maker_depth') {
        promptSetting(chatId, `Reply with *Hop Depth* (1-5):`, (val) => {
            try { STATE.makerFundingChainDepth = validateNumber(val, 1, 5, "Depth"); saveConfig(); bot.sendMessage(chatId, `✅ Depth: \`${STATE.makerFundingChainDepth}\``); } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
            showStealthSettings(chatId);
        });
    }

    // Wallet pool operations
    else if (action === 'pool_generate') {
        promptSetting(chatId, `🔨 Generate wallets (e.g. \`1000\`, \`10000\`):\n\nCurrent pool: \`${walletManager.size}\``, async (val) => {
            const count = parseInt(val);
            if (isNaN(count) || count <= 0) return bot.sendMessage(chatId, `❌ Invalid number.`);
            if (count > 100000) return bot.sendMessage(chatId, `❌ Max 100,000 per generation.`);
            bot.sendMessage(chatId, `⏳ Generating ${count.toLocaleString()}...`);
            const generated = await walletManager.generateWallets?.(count) || count;
            bot.sendMessage(chatId, `✅ Generated *${generated.toLocaleString()}*!\nTotal: *${walletManager.size.toLocaleString()}*`, { parse_mode: 'Markdown' });
            showWalletPoolMenu(chatId);
        });
    }
    else if (action === 'pool_fund') {
        if (walletManager.size === 0) return bot.sendMessage(chatId, `❌ No wallets. Generate first!`);
        if (!masterKeypair) return bot.sendMessage(chatId, `❌ No master wallet.`);
        const estCost = (walletManager.size * STATE.fundAmountPerWallet).toFixed(2);
        promptSetting(chatId, `💰 *Fund Pool*\n\nWallets: \`${walletManager.size}\`\nPer wallet: \`${STATE.fundAmountPerWallet}\` SOL\n*Est. cost: \`${estCost}\` SOL*\n\nReply \`YES\` to confirm:`, async (val) => {
            if (val.toUpperCase() !== 'YES') return bot.sendMessage(chatId, `❌ Cancelled.`);
            await withRpcFallback(async (connection) => {
                bot.sendMessage(chatId, `💰 Funding ${walletManager.size} wallets...`);
                const result = await walletManager.fundAll(connection, masterKeypair, sendSOL, STATE.fundAmountPerWallet, STATE.batchConcurrency);
                bot.sendMessage(chatId, `✅ Funding complete. ${result.successes} succeeded, ${result.failures} failed.`);
                showWalletPoolMenu(chatId);
            });
        });
    }
    else if (action === 'pool_drain') {
        if (walletManager.size === 0) return bot.sendMessage(chatId, `❌ No wallets.`);
        if (!masterKeypair) return bot.sendMessage(chatId, `❌ No master wallet.`);
        promptSetting(chatId, `🔄 *Drain Pool*\n\nReply \`YES\` to confirm:`, async (val) => {
            if (val.toUpperCase() !== 'YES') return bot.sendMessage(chatId, `❌ Cancelled.`);
            await withRpcFallback(async (connection) => {
                bot.sendMessage(chatId, `🔄 Draining ${walletManager.size} wallets...`);
                await walletManager.drainAll(connection, masterKeypair, sendSOL, STATE.batchConcurrency);
                showWalletPoolMenu(chatId);
            });
        });
    }
    else if (action === 'pool_scan') {
        await withRpcFallback(async (connection) => {
            bot.sendMessage(chatId, `📊 Scanning ${walletManager.size} wallets...`);
            const scan = await walletManager.scanBalances(connection, 30);
            bot.sendMessage(chatId, `📊 *Scan Complete*\nTotal SOL: \`${scan.totalSOL.toFixed(4)}\`\nFunded: \`${scan.funded}\` | Empty: \`${scan.empty}\``, { parse_mode: 'Markdown' });
            showWalletPoolMenu(chatId);
        });
    }
    else if (action === 'pool_toggle') { STATE.useWalletPool = !STATE.useWalletPool; saveConfig(); bot.sendMessage(chatId, `✅ Pool Mode: *${STATE.useWalletPool ? 'ON' : 'OFF'}*`, { parse_mode: 'Markdown' }); showWalletPoolMenu(chatId); }
    else if (action === 'pool_clear') {
        promptSetting(chatId, `⚠️ *Clear ALL ${walletManager.size} wallets?* Reply \`DELETE\` to confirm:`, (val) => {
            if (val.toUpperCase() !== 'DELETE') return bot.sendMessage(chatId, `❌ Cancelled.`);
            walletManager.clearAll?.(); bot.sendMessage(chatId, `✅ Pool cleared.`); showWalletPoolMenu(chatId);
        });
    }
    else if (action === 'set_fund_amount') {
        promptSetting(chatId, `Reply with *SOL per wallet* (e.g. \`0.01\`):`, (val) => {
            STATE.fundAmountPerWallet = parseFloat(val); saveConfig(); bot.sendMessage(chatId, `✅ Fund Amt: \`${STATE.fundAmountPerWallet}\` SOL/wallet`, { parse_mode: 'Markdown' }); showWalletPoolMenu(chatId);
        });
    }

    // Smart Sell callbacks
    else if (action === 'toggle_smart_sell') {
        STATE.smartSellEnabled = !STATE.smartSellEnabled;
        saveConfig();
        bot.sendMessage(chatId, `🧠 Smart Sell ${STATE.smartSellEnabled ? 'enabled' : 'disabled'}.`);
        if (STATE.running && STATE.smartSellEnabled && STATE.tokenAddress) {
            startSmartSellMonitor(getConnection(), STATE.tokenAddress);
        } else if (smartSellInterval && !STATE.smartSellEnabled) {
            clearInterval(smartSellInterval);
            smartSellInterval = null;
        }
        showSmartSellMenu(chatId);
    }
    else if (action === 'set_smart_percent') {
        promptSetting(chatId, `Reply with *Sell %* (1-100):`, (val) => {
            const p = parseFloat(val);
            if (isNaN(p) || p < 1 || p > 100) return bot.sendMessage(chatId, `❌ Enter 1-100.`);
            STATE.smartSellPercent = p;
            saveConfig();
            bot.sendMessage(chatId, `✅ Sell % set to ${p}%.`);
            showSmartSellMenu(chatId);
        });
    }
    else if (action === 'set_smart_max_wallets') {
        promptSetting(chatId, `Reply with *Max wallets* (1-100):`, (val) => {
            let m = parseInt(val);
            if (isNaN(m)) m = 50;
            STATE.smartSellMaxWallets = Math.min(100, Math.max(1, m));
            saveConfig();
            bot.sendMessage(chatId, `✅ Max wallets: ${STATE.smartSellMaxWallets}.`);
            showSmartSellMenu(chatId);
        });
    }
    else if (action === 'set_smart_min_buy') {
        promptSetting(chatId, `Reply with *Min buy SOL* to trigger (0.001-10):`, (val) => {
            let m = parseFloat(val);
            if (isNaN(m) || m < 0.001) m = 0.01;
            STATE.smartSellMinBuySOL = m;
            saveConfig();
            bot.sendMessage(chatId, `✅ Min buy SOL: ${STATE.smartSellMinBuySOL}.`);
            showSmartSellMenu(chatId);
        });
    }
    else if (action === 'set_smart_cooldown') {
        promptSetting(chatId, `Reply with *Cooldown seconds* (10-3600):`, (val) => {
            let sec = parseInt(val);
            if (isNaN(sec) || sec < 10) sec = 60;
            STATE.smartSellCooldownMs = sec * 1000;
            saveConfig();
            bot.sendMessage(chatId, `✅ Cooldown: ${sec}s per wallet.`);
            showSmartSellMenu(chatId);
        });
    }
    else if (action === 'set_smart_dev_wallet') {
        promptSetting(chatId, `🔑 Send the *private key* (base58) of the wallet you want to use for selling.\n\n⚠️ This key will be kept in memory only (not saved to config.json).`, async (privateKey) => {
            await setSmartSellDevWallet(privateKey, chatId);
            showSmartSellMenu(chatId);
        });
    }
    else if (action === 'clear_smart_dev_wallet') {
        STATE.smartSellDevWalletPubkey = "";
        STATE.smartSellDevWalletKeypair = null;
        saveConfig();
        bot.sendMessage(chatId, `🗑️ Dev wallet cleared. Smart Sell will now use random holder wallets.`, { parse_mode: 'Markdown' });
        showSmartSellMenu(chatId);
    }
});

// ─────────────────────────────────────────────
// 🚀 Bot Entry Point
// ─────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
    if (isAdmin(msg.chat.id)) showMainMenu(msg.chat.id);
    else bot.sendMessage(msg.chat.id, "⛔ Unauthorized access.", { parse_mode: 'Markdown' });
});

logger.info(`🚀 Volume Bot v3.2 started | Strategies: 19 | Wallets: ${walletManager.size.toLocaleString()}`);
logger.info(`🌐 RPC: ${RPC_URLS.length} | Jito: ${STATE.useJito ? 'ON' : 'OFF'} | Stealth: Level ${STATE.fundingStealthLevel}`);
logger.info(`🧠 Smart Sell: ${STATE.smartSellEnabled ? 'ENABLED' : 'DISABLED'} | Dev Wallet: ${STATE.smartSellDevWalletPubkey ? 'SET' : 'NOT SET'}`);

export { STATE, walletManager, swap, sendSOL, getTokenBalance, WalletManager, BatchSwapEngine, sendJitoBundle };
