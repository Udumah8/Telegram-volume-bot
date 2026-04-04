// ─────────────────────────────────────────────
// 🤖 Solana Volume Bot v3.1 - Production Ready
// 🔧 Unified Wallet Management | Fixed Strategies | Enhanced Safety
// ─────────────────────────────────────────────

import fs from "fs";
import 'dotenv/config';
import { Connection, Keypair, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { SolanaTracker } from "solana-swap";
import { Buffer } from "buffer";
import bs58 from "bs58";
import TelegramBot from "node-telegram-bot-api";
import { sendJitoBundle } from "./jito.js";
import { WalletPool } from "./walletManager.js";
import { BatchSwapEngine } from "./batchEngine.js";
import winston from 'winston';

// ─────────────────────────────────────────────
// 🛡️ Global Safety Guards
// ─────────────────────────────────────────────
let isShuttingDown = false;
let activeStrategy = null;
let lastCommandTime = new Map();

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
    
    // Cancel active strategy
    if (activeStrategy) {
        logger?.info(`🔄 Cancelling active strategy: ${activeStrategy}`);
        if (bot && ADMIN_CHAT_ID) {
            bot.sendMessage(ADMIN_CHAT_ID, `⚠️ Strategy ${activeStrategy} cancelled due to shutdown`, { parse_mode: 'Markdown' }).catch(() => {});
        }
    }
    
    // Persist state
    saveConfig();
    
    // Allow in-flight operations to complete (max 5s)
    await sleep(5000);
    
    // Global ephemeral cleanup
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
            Object.assign(STATE, saved);
            logger.info(`✅ Configuration loaded from ${CONFIG_FILE}`);
        }
    } catch (e) {
        logger.error(`❌ Failed to load config: ${e.message}`);
    }
}

// ─────────────────────────────────────────────
// 🪪 Unified Wallet Manager: Pool vs Ephemeral
// ─────────────────────────────────────────────
class WalletManager {
    constructor(pool, masterKeypair, connection) {
        this.pool = pool;
        this.master = masterKeypair;
        this.connection = connection;
        this.ephemeralWallets = [];
    }

    getWallets(count) {
        const usePool = STATE.useWalletPool && this.pool?.size > 0;
        
        if (usePool) {
            return this.pool.getRandomSubset(Math.min(count, this.pool.size));
        } else {
            const ephemeral = [];
            for (let i = 0; i < count; i++) {
                const kp = Keypair.generate();
                ephemeral.push(kp);
                this.ephemeralWallets.push(kp);
            }
            return ephemeral;
        }
    }

    isEphemeral() {
        return !STATE.useWalletPool || this.pool?.size === 0;
    }

    async fundWallets(wallets, amountPerWallet, chatId, onProgress = null) {
        if (!wallets?.length || !this.master) return { success: 0, failed: 0 };
        
        const useStealth = STATE.useWebFunding && STATE.fundingStealthLevel === 2;
        let successCount = 0;
        let failedCount = 0;

        try {
            if (useStealth) {
                await this._fundStealth(wallets, amountPerWallet, chatId);
                successCount = wallets.length;
            } else {
                for (let i = 0; i < wallets.length && STATE.running && !isShuttingDown; i++) {
                    try {
                        await sendSOL(this.connection, this.master, wallets[i].publicKey, amountPerWallet);
                        successCount++;
                        if (onProgress && (i + 1) % 10 === 0) {
                            onProgress({ funded: i + 1, total: wallets.length });
                        }
                        await sleep(getPoissonDelay(800));
                    } catch (err) {
                        failedCount++;
                        logger.warn(`[Fund] Wallet ${i+1} failed: ${err.message}`);
                    }
                }
            }
            logger.info(`[Fund] Complete: ${successCount} succeeded, ${failedCount} failed`);
            return { success: successCount, failed: failedCount };
        } catch (err) {
            logger.error(`[Fund] Critical error: ${err.message}`);
            return { success: successCount, failed: failedCount + (wallets.length - successCount) };
        }
    }

    async _fundStealth(targets, amountPerWallet, chatId) {
        const maxDepth = STATE.makerFundingChainDepth;
        const intermediates = [];

        for (const target of targets) {
            if (!STATE.running || isShuttingDown) break;
            const depth = Math.floor(getRandomFloat(1, maxDepth + 1));
            let current = this.master;
            let remainingAmount = amountPerWallet + (0.005 * depth);

            for (let hop = 0; hop < depth; hop++) {
                const next = hop === depth - 1 ? target : Keypair.generate();
                if (hop < depth - 1) intermediates.push(next);
                
                try {
                    await sendSOL(this.connection, current, next.publicKey, remainingAmount);
                    current = next;
                    remainingAmount -= 0.004;
                    await sleep(getPoissonDelay(1500));
                } catch (err) {
                    logger.warn(`[StealthFund] Hop ${hop+1} failed: ${err.message}`);
                    break;
                }
            }
            await sleep(getPoissonDelay(2500));
        }

        if (intermediates.length > 0) {
            await this._drainIntermediates(intermediates, chatId);
        }
    }

    async drainWallets(wallets, chatId, keepMinimum = 10000) {
        if (!wallets?.length || !this.master) return { success: 0, failed: 0 };
        
        let successCount = 0;
        let failedCount = 0;

        for (const wallet of wallets) {
            if (!STATE.running || isShuttingDown) break;
            try {
                const balance = await this.connection.getBalance(wallet.publicKey);
                if (balance > keepMinimum) {
                    const amount = (balance - keepMinimum) / LAMPORTS_PER_SOL;
                    await sendSOL(this.connection, wallet, this.master.publicKey, amount);
                    successCount++;
                    await sleep(400);
                }
            } catch (err) {
                failedCount++;
                logger.debug(`[Drain] ${wallet.publicKey.toBase58().slice(0,8)}: ${err.message}`);
            }
        }

        this.ephemeralWallets = this.ephemeralWallets.filter(w => !wallets.includes(w));
        logger.info(`[Drain] Complete: ${successCount} succeeded, ${failedCount} failed`);
        return { success: successCount, failed: failedCount };
    }

    async _drainIntermediates(intermediates, chatId) {
        for (const inter of intermediates) {
            if (!STATE.running || isShuttingDown) break;
            try {
                const bal = await this.connection.getBalance(inter.publicKey);
                if (bal > 10000) {
                    await sendSOL(this.connection, inter, this.master.publicKey, (bal - 10000) / LAMPORTS_PER_SOL);
                    await sleep(300);
                }
            } catch (err) {
                logger.warn(`[Drain] Intermediate failed: ${err.message}`);
            }
        }
    }

    async cleanup(chatId) {
        if (this.ephemeralWallets.length > 0) {
            logger.info(`[Cleanup] Draining ${this.ephemeralWallets.length} ephemeral wallets`);
            await this.drainWallets(this.ephemeralWallets, chatId);
            this.ephemeralWallets = [];
        }
    }
}

// Global instance for shutdown cleanup
let globalWalletManager = null;

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
// 👥 User Session Management with Cleanup
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
        if (now - session.created > 300000) {
            expired.push(chatId);
        }
    }
    for (const cid of expired) {
        clearTimeout(userSessions.get(cid).timeout);
        userSessions.delete(cid);
        logger.debug(`🧹 Auto-cleaned expired session: ${cid}`);
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
    WHALE:   { buyProb: 0.3, sellProb: 0.05, minHold: 10, maxHold: 30, sizeMult: 3.0, minThink: 3000, maxThink: 20000 }
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
    personalityMix: ['RETAIL', 'SCALPER', 'DIAMOND'], walletPoolSize: 100
};

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
        return await sendJitoBundle([b58Tx], from, connection, STATE.jitoTipAmount);
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
// 🔄 Swap Function with Retries + Validation
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

            if (STATE.swapProvider === "SOLANA_TRADE" && typeof SolanaTrade !== 'undefined') {
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
                    txid = await sendJitoBundle([b58Tx], keypair, connection, STATE.jitoTipAmount);
                } else {
                    txid = await solanaTracker.performSwap(swapResponse, { sendOptions: { skipPreflight: false, preflightCommitment: 'confirmed' }, commitment: "confirmed" });
                }
                if (!silent && txid) bot.sendMessage(chatId, `✅ [Tx](https://solscan.io/tx/${txid})`, { parse_mode: 'Markdown' }).catch(() => {});
                return txid;
            }
        } catch (e) {
            lastError = e;
            logger.warn(`[Swap] ${shortKey} attempt ${attempt + 1}/${maxRetries}: ${e.message}`);
            if (attempt < maxRetries - 1) { await sleep(Math.min(1000 * Math.pow(2, attempt), 3000)); continue; }
        }
    }
    logger.error(`[Swap] ${shortKey} failed after ${maxRetries} attempts: ${lastError?.message || "Unknown"}`);
    if (!silent && chatId) bot.sendMessage(chatId, `⚠️ Swap failed [${shortKey}...]: ${lastError?.message || "Unknown error"}`).catch(() => {});
    return null;
}

// ─────────────────────────────────────────────
// 🧹 Drain Wallets Helper (Legacy Support)
// ─────────────────────────────────────────────
async function drainWallets(connection, wallets, masterPubkey, chatId) {
    if (!wallets?.length) return;
    let successCount = 0;
    bot.sendMessage(chatId, `🧹 Draining ${wallets.length} wallets...`, { parse_mode: 'Markdown' }).catch(() => {});
    for (const w of wallets) {
        if (!STATE.running || isShuttingDown) break;
        try {
            const bal = await connection.getBalance(w.publicKey);
            if (bal > 10000) {
                await sendSOL(connection, w, masterPubkey, (bal - 10000) / LAMPORTS_PER_SOL);
                successCount++;
                await sleep(500);
            }
        } catch (err) { logger.warn(`[Drain] Wallet ${w.publicKey.toBase58().slice(0,8)} failed: ${err.message}`); }
    }
    logger.info(`[Drain] Complete: ${successCount}/${wallets.length} drained`);
    if (chatId) bot.sendMessage(chatId, `✅ Drain complete: ${successCount}/${wallets.length} succeeded.`, { parse_mode: 'Markdown' }).catch(() => {});
}

// ─────────────────────────────────────────────
// 🔄 Universal Strategy Executor Template
// ─────────────────────────────────────────────
async function executeStrategyTemplate(chatId, connection, strategyConfig) {
    const { name, walletCount, fundAmount, buyLogic, sellLogic, cycles, interCycleDelay, needsFunding = true, needsDraining = true } = strategyConfig;
    const walletMgr = new WalletManager(walletPool, masterKeypair, connection);
    globalWalletManager = walletMgr;
    
    try {
        bot.sendMessage(chatId, `🚀 Starting *${name}*...`, { parse_mode: 'Markdown' });
        const wallets = walletMgr.getWallets(walletCount);
        const isEphemeral = walletMgr.isEphemeral();

        if (isEphemeral && needsFunding && fundAmount > 0) {
            bot.sendMessage(chatId, `💰 Funding ${wallets.length} ephemeral wallets...`, { parse_mode: 'Markdown' });
            const fundResult = await walletMgr.fundWallets(wallets, fundAmount, chatId, (prog) => bot.sendMessage(chatId, `💰 Progress: ${prog.funded}/${prog.total}`, { parse_mode: 'Markdown' }).catch(() => {}));
            if (fundResult.failed > 0) bot.sendMessage(chatId, `⚠️ ${fundResult.failed} funding failures - continuing`, { parse_mode: 'Markdown' });
            await sleep(3000);
        }

        let cycleMsg = null;
        for (let cycle = 0; cycle < cycles && STATE.running && !isShuttingDown; cycle++) {
            const volMult = getVolumeMultiplier();
            cycleMsg = await bot.sendMessage(chatId, `🔄 ${name} Cycle ${cycle + 1}/${cycles} | Vol: ${volMult.toFixed(2)}x`, { parse_mode: 'Markdown' });

            const buyResults = await BatchSwapEngine.executeBatch(wallets, async (wallet, idx) => { if (!STATE.running || isShuttingDown) return null; return await buyLogic(wallet, idx, volMult, connection, chatId); }, STATE.batchConcurrency, (progress) => { if (progress.completed % Math.max(1, Math.floor(progress.total / 5)) === 0) bot.editMessageText(`🔄 ${name} Cycle ${cycle + 1}/${cycles}\n🛒 Buying: ${progress.completed}/${progress.total} | ✅ ${progress.successes} | ❌ ${progress.failures}`, { chat_id: chatId, message_id: cycleMsg?.message_id, parse_mode: "Markdown" }).catch(() => {}); }, () => STATE.running && !isShuttingDown);

            if (!STATE.running || isShuttingDown) break;
            await sleep(getPoissonDelay(STATE.intervalBetweenActions));

            await BatchSwapEngine.executeBatch(wallets, async (wallet, idx) => { if (!STATE.running || isShuttingDown) return null; return await sellLogic(wallet, idx, volMult, connection, chatId); }, STATE.batchConcurrency, null, () => STATE.running && !isShuttingDown);

            if (cycle < cycles - 1 && STATE.running && !isShuttingDown) { await sleep(getPoissonDelay(interCycleDelay || STATE.intervalBetweenActions * 2)); }
        }

        if (isEphemeral && needsDraining && STATE.running && !isShuttingDown) {
            bot.sendMessage(chatId, `🧹 Draining ephemeral wallets...`, { parse_mode: 'Markdown' });
            await walletMgr.drainWallets(wallets, chatId);
        }
        bot.sendMessage(chatId, `✅ *${name}* complete!`, { parse_mode: 'Markdown' });
        return { success: true };
    } catch (err) {
        logger.error(`[${name}] Fatal error: ${err.message}\n${err.stack}`);
        bot.sendMessage(chatId, `❌ ${name} failed: ${err.message}`, { parse_mode: 'Markdown' }).catch(() => {});
        return { success: false, error: err.message };
    } finally {
        await walletMgr.cleanup(chatId);
        globalWalletManager = null;
    }
}

// ─────────────────────────────────────────────
// 📈 Strategy: Standard Cycles (Fixed)
// ─────────────────────────────────────────────
async function executeStandardCycles(chatId, connection) {
    return executeStrategyTemplate(chatId, connection, {
        name: 'Standard Mode',
        walletCount: STATE.useWalletPool ? Math.min(STATE.walletsPerCycle, walletPool.size) : 1,
        fundAmount: STATE.fundAmountPerWallet,
        buyLogic: async (wallet, idx, volMult, conn, cid) => { const amount = parseFloat((getRandomFloat(STATE.minBuyAmount, STATE.maxBuyAmount) * volMult).toFixed(4)); return await swap(SOL_ADDR, STATE.tokenAddress, wallet, conn, amount, cid, true); },
        sellLogic: async (wallet, idx, volMult, conn, cid) => { const bal = await getTokenBalance(conn, wallet.publicKey, STATE.tokenAddress); if (bal > 0.0001) return await swap(STATE.tokenAddress, SOL_ADDR, wallet, conn, 'auto', cid, true); return null; },
        cycles: STATE.numberOfCycles, interCycleDelay: STATE.intervalBetweenActions * 2, needsFunding: true, needsDraining: true
    });
}

// ─────────────────────────────────────────────
// 📈 Strategy: Maker Cycles (Fixed - Personality-Driven)
// ─────────────────────────────────────────────
async function executeMakerCycles(chatId, connection) {
    const walletCount = STATE.useWalletPool ? Math.min(STATE.walletsPerCycle, walletPool.size) : STATE.makerWalletsToGenerate;
    return executeStrategyTemplate(chatId, connection, {
        name: 'Maker Mode', walletCount,
        fundAmount: parseFloat(getRandomFloat(STATE.minBuyAmount, STATE.maxBuyAmount).toFixed(4)) + 0.01,
        buyLogic: async (wallet, idx, volMult, conn, cid) => {
            if (!wallet.personality) { const pKey = STATE.personalityMix[Math.floor(Math.random() * STATE.personalityMix.length)]; wallet.personality = PERSONALITIES[pKey] || PERSONALITIES.RETAIL; wallet.holdCycles = 0; }
            const bal = await getTokenBalance(conn, wallet.publicKey, STATE.tokenAddress); if (bal > 0) return null;
            if (Math.random() < wallet.personality.buyProb) {
                await sleep(getRandomFloat(wallet.personality.minThink, wallet.personality.maxThink));
                const amount = parseFloat((getRandomFloat(STATE.minBuyAmount, STATE.maxBuyAmount) * wallet.personality.sizeMult * volMult).toFixed(4));
                wallet.holdCycles = Math.floor(getRandomFloat(wallet.personality.minHold, wallet.personality.maxHold));
                return await swap(SOL_ADDR, STATE.tokenAddress, wallet, conn, amount, cid, true);
            } return null;
        },
        sellLogic: async (wallet, idx, volMult, conn, cid) => {
            if (!wallet.personality) return null;
            const bal = await getTokenBalance(conn, wallet.publicKey, STATE.tokenAddress); if (bal <= 0.0001) return null;
            if (wallet.holdCycles <= 0 && Math.random() < wallet.personality.sellProb) {
                await sleep(getRandomFloat(wallet.personality.minThink, wallet.personality.maxThink));
                const sellAmt = Math.random() < 0.7 ? 'auto' : (bal * getRandomFloat(0.3, 0.7)).toFixed(6);
                return await swap(STATE.tokenAddress, SOL_ADDR, wallet, conn, sellAmt, cid, true);
            } else if (wallet.holdCycles > 0) wallet.holdCycles--; return null;
        },
        cycles: STATE.numberOfCycles, interCycleDelay: STATE.intervalBetweenActions, needsFunding: !STATE.useWalletPool, needsDraining: !STATE.useWalletPool
    });
}

// ─────────────────────────────────────────────
// 🕸️ Strategy: Web of Activity (Fixed)
// ─────────────────────────────────────────────
async function executeWebOfActivity(chatId, connection) {
    const walletCount = STATE.useWalletPool ? Math.min(STATE.walletsPerCycle, walletPool.size) : 5;
    return executeStrategyTemplate(chatId, connection, {
        name: 'Web of Activity', walletCount, fundAmount: 0.05,
        buyLogic: async (wallet, idx, volMult, conn, cid) => { const amt = parseFloat((getRandomFloat(STATE.minBuyAmount, STATE.maxBuyAmount) * volMult).toFixed(4)); return swap(SOL_ADDR, STATE.tokenAddress, wallet, conn, amt, cid, true); },
        sellLogic: async (wallet, idx, volMult, conn, cid) => { const bal = await getTokenBalance(conn, wallet.publicKey, STATE.tokenAddress); if (bal > 0 && Math.random() < 0.6) return swap(STATE.tokenAddress, SOL_ADDR, wallet, conn, 'auto', cid, true); return null; },
        cycles: STATE.numberOfCycles, interCycleDelay: STATE.intervalBetweenActions, needsFunding: !STATE.useWalletPool, needsDraining: !STATE.useWalletPool
    });
}

// ─────────────────────────────────────────────
// ⚡ Strategy: Spam Mode (Fixed)
// ─────────────────────────────────────────────
async function executeSpamMode(chatId, connection) {
    const walletCount = STATE.useWalletPool ? Math.min(STATE.walletsPerCycle, walletPool.size) : 5;
    const result = await executeStrategyTemplate(chatId, connection, {
        name: 'Micro-Spam Mode', walletCount, fundAmount: STATE.fundAmountPerWallet,
        buyLogic: async (wallet, idx, volMult, conn, cid) => { const jitteredSpam = parseFloat((STATE.spamMicroBuyAmount * (0.8 + Math.random() * 0.4)).toFixed(6)); return await swap(SOL_ADDR, STATE.tokenAddress, wallet, conn, jitteredSpam, cid, true); },
        sellLogic: async () => null, cycles: STATE.numberOfCycles, interCycleDelay: 1500, needsFunding: !STATE.useWalletPool, needsDraining: !STATE.useWalletPool
    });
    
    if (result.success && STATE.running && !isShuttingDown) {
        bot.sendMessage(chatId, `📉 Dumping accumulated tokens...`, { parse_mode: 'Markdown' });
        const walletMgr = new WalletManager(walletPool, masterKeypair, connection);
        const dumpWallets = walletMgr.getWallets(walletCount);
        await BatchSwapEngine.executeBatch(dumpWallets, async (w) => { const bal = await getTokenBalance(connection, w.publicKey, STATE.tokenAddress); if (bal > 0) return swap(STATE.tokenAddress, SOL_ADDR, w, connection, 'auto', chatId, true); return null; }, STATE.batchConcurrency, null, () => STATE.running && !isShuttingDown);
        if (walletMgr.isEphemeral()) await walletMgr.drainWallets(dumpWallets, chatId);
    }
    return result;
}

// ─────────────────────────────────────────────
// 🚀 Strategy: Pump & Dump (Fixed)
// ─────────────────────────────────────────────
async function executePumpDump(chatId, connection) {
    const walletCount = STATE.useWalletPool ? Math.min(STATE.walletsPerCycle, walletPool.size) : 1;
    const result = await executeStrategyTemplate(chatId, connection, {
        name: 'Pump & Dump', walletCount, fundAmount: STATE.fundAmountPerWallet,
        buyLogic: async (wallet, idx, volMult, conn, cid) => { const buyAmount = parseFloat(getRandomFloat(STATE.minBuyAmount, STATE.maxBuyAmount).toFixed(4)); return await swap(SOL_ADDR, STATE.tokenAddress, wallet, conn, buyAmount, cid, true); },
        sellLogic: async () => null, cycles: STATE.numberOfCycles, interCycleDelay: STATE.intervalBetweenActions, needsFunding: !STATE.useWalletPool, needsDraining: false
    });
    
    if (result.success && STATE.running && !isShuttingDown) {
        const walletMgr = new WalletManager(walletPool, masterKeypair, connection);
        const dumpWallets = walletMgr.getWallets(Math.min(5, walletCount));
        bot.sendMessage(chatId, `🔴 *Dumping in stealth chunks*...`, { parse_mode: 'Markdown' });
        for (const w of dumpWallets) {
            if (!STATE.running || isShuttingDown) break;
            const bal = await getTokenBalance(connection, w.publicKey, STATE.tokenAddress);
            if (bal > 0) {
                const chunks = Math.floor(getRandomFloat(2, 4)); const chunkSize = bal / chunks;
                for (let c = 0; c < chunks; c++) { const amt = (c === chunks-1) ? 'auto' : chunkSize.toFixed(6); await swap(STATE.tokenAddress, SOL_ADDR, w, connection, amt, chatId, true); if (c < chunks - 1) await sleep(getJitteredInterval(1000, 20)); }
            }
        }
        if (walletMgr.isEphemeral()) await walletMgr.drainWallets(dumpWallets, chatId);
    }
    return result;
}

// ─────────────────────────────────────────────
// 📐 Strategy: Chart Pattern (Fixed)
// ─────────────────────────────────────────────
async function executeChartPattern(chatId, connection) {
    const walletCount = STATE.useWalletPool ? Math.min(STATE.walletsPerCycle, walletPool.size) : 5;
    return executeStrategyTemplate(chatId, connection, {
        name: `Chart Pattern: ${STATE.chartPattern}`, walletCount, fundAmount: STATE.fundAmountPerWallet,
        buyLogic: async (wallet, idx, volMult, conn, cid) => {
            const n = STATE.numberOfCycles, progress = idx / Math.max(n - 1, 1); let buyMult;
            switch (STATE.chartPattern) {
                case 'ASCENDING': buyMult = 0.5 + progress; break; case 'DESCENDING': buyMult = 1.5 - progress; break;
                case 'SIDEWAYS': buyMult = 0.9 + Math.sin(progress * Math.PI * 4) * 0.2; break;
                case 'CUP_HANDLE': const cup = Math.sin(progress * Math.PI), handle = progress > 0.8 ? 0.3 * Math.sin((progress - 0.8) * Math.PI / 0.2) : 0; buyMult = 0.4 + cup * 0.8 - handle * 0.3; break;
                case 'BREAKOUT': default: buyMult = progress < 0.7 ? 0.6 : 1.8;
            }
            const jitteredBuy = parseFloat((STATE.minBuyAmount + (STATE.maxBuyAmount - STATE.minBuyAmount) * buyMult * 0.7 * (0.85 + Math.random() * 0.3)).toFixed(4));
            return await swap(SOL_ADDR, STATE.tokenAddress, wallet, conn, jitteredBuy, cid, true);
        },
        sellLogic: async (wallet, idx, volMult, conn, cid) => {
            const n = STATE.numberOfCycles, progress = idx / Math.max(n - 1, 1); let sellFrac;
            switch (STATE.chartPattern) {
                case 'ASCENDING': sellFrac = 0.3 + (1 - progress) * 0.4; break; case 'DESCENDING': sellFrac = 0.3 + progress * 0.6; break;
                case 'SIDEWAYS': case 'CUP_HANDLE': sellFrac = 0.85; break; case 'BREAKOUT': default: sellFrac = progress < 0.7 ? 0.9 : 0.2;
            }
            const bal = await getTokenBalance(conn, wallet.publicKey, STATE.tokenAddress);
            if (bal > 0) { const sellAmt = parseFloat((bal * sellFrac).toFixed(6)); return swap(STATE.tokenAddress, SOL_ADDR, wallet, conn, sellAmt > 0 ? sellAmt : 'auto', cid, true); }
            return null;
        },
        cycles: STATE.numberOfCycles, interCycleDelay: STATE.intervalBetweenActions, needsFunding: !STATE.useWalletPool, needsDraining: !STATE.useWalletPool
    });
}

// ─────────────────────────────────────────────
// 👥 Strategy: Holder Growth (Fixed)
// ─────────────────────────────────────────────
async function executeHolderGrowth(chatId, connection) {
    const count = STATE.useWalletPool ? Math.min(STATE.holderWallets, walletPool.size) : STATE.holderWallets;
    return executeStrategyTemplate(chatId, connection, {
        name: 'Holder Growth', walletCount: count, fundAmount: STATE.holderBuyAmount + 0.003,
        buyLogic: async (wallet, idx, volMult, conn, cid) => { const amtVariation = getRandomFloat(STATE.holderBuyAmount * 0.7, STATE.holderBuyAmount * 1.3); return await swap(SOL_ADDR, STATE.tokenAddress, wallet, conn, amtVariation, cid, true); },
        sellLogic: async () => null, cycles: 1, interCycleDelay: 0, needsFunding: !STATE.useWalletPool, needsDraining: !STATE.useWalletPool
    });
}

// ─────────────────────────────────────────────
// 🐋 Strategy: Whale Simulation (Fixed)
// ─────────────────────────────────────────────
async function executeWhaleSimulation(chatId, connection) {
    const whaleCount = STATE.useWalletPool ? Math.min(5, walletPool.size) : 1;
    const result = await executeStrategyTemplate(chatId, connection, {
        name: 'Whale Simulation', walletCount: whaleCount, fundAmount: STATE.whaleBuyAmount + 0.01,
        buyLogic: async (wallet, idx, volMult, conn, cid) => { const jitteredAmt = parseFloat((STATE.whaleBuyAmount * (0.85 + Math.random() * 0.3) * volMult).toFixed(4)); return await swap(SOL_ADDR, STATE.tokenAddress, wallet, conn, jitteredAmt, cid, true); },
        sellLogic: async () => null, cycles: STATE.numberOfCycles, interCycleDelay: STATE.intervalBetweenActions * 2, needsFunding: !STATE.useWalletPool, needsDraining: false
    });
    
    if (result.success && STATE.running && !isShuttingDown) {
        const walletMgr = new WalletManager(walletPool, masterKeypair, connection);
        const activeWhales = walletMgr.getWallets(whaleCount);
        bot.sendMessage(chatId, `🔴 Whale dumping ${STATE.whaleSellPercent}% in stealth chunks...`, { parse_mode: 'Markdown' });
        for (const w of activeWhales) {
            if (!STATE.running || isShuttingDown) break;
            const bal = await getTokenBalance(connection, w.publicKey, STATE.tokenAddress);
            if (bal > 0) {
                const dumpChunks = Math.floor(getRandomFloat(2, 5)); const chunkPercent = (STATE.whaleSellPercent / 100) / dumpChunks;
                for (let c = 0; c < dumpChunks; c++) { const dumpAmt = parseFloat((bal * chunkPercent).toFixed(6)); await swap(STATE.tokenAddress, SOL_ADDR, w, connection, dumpAmt, chatId, true); await sleep(getJitteredInterval(800, 15)); }
            }
        }
        if (walletMgr.isEphemeral()) await walletMgr.drainWallets(activeWhales, chatId);
    }
    return result;
}

// ─────────────────────────────────────────────
// 📊 Strategy: Volume Boost (Fixed)
// ─────────────────────────────────────────────
async function executeVolumeBoost(chatId, connection) {
    const walletCount = STATE.useWalletPool ? Math.min(STATE.walletsPerCycle, walletPool.size) : STATE.volumeBoostMultiplier;
    return executeStrategyTemplate(chatId, connection, {
        name: 'Volume Boost', walletCount, fundAmount: STATE.volumeBoostMaxAmount + 0.01,
        buyLogic: async (wallet, idx, volMult, conn, cid) => { await sleep(getRandomFloat(0, 2000)); const amt = parseFloat(getRandomFloat(STATE.volumeBoostMinAmount, STATE.volumeBoostMaxAmount).toFixed(4)); return swap(SOL_ADDR, STATE.tokenAddress, wallet, conn, amt, cid, true); },
        sellLogic: async (wallet, idx, volMult, conn, cid) => { const bal = await getTokenBalance(conn, wallet.publicKey, STATE.tokenAddress); if (bal > 0) return swap(STATE.tokenAddress, SOL_ADDR, wallet, conn, 'auto', cid, true); return null; },
        cycles: STATE.volumeBoostCycles, interCycleDelay: 3000, needsFunding: !STATE.useWalletPool, needsDraining: !STATE.useWalletPool
    });
}

// ─────────────────────────────────────────────
// 🔥 Strategy: Trending Modes (Fixed - Full Implementation)
// ─────────────────────────────────────────────
async function executeTrendingStrategy(chatId, connection) {
    const mode = STATE.trendingMode;
    const intensity = STATE.trendingIntensity;
    const walletCount = STATE.useWalletPool ? Math.min(STATE.walletsPerCycle, walletPool.size) : 1;
    
    if (mode === 'VIRAL_PUMP') {
        const cycles = Math.floor(5 + intensity * 2);
        for (let i = 0; i < cycles && STATE.running && !isShuttingDown; i++) {
            const walletMgr = new WalletManager(walletPool, masterKeypair, connection);
            const freshWallets = walletMgr.getWallets(walletCount);
            if (walletMgr.isEphemeral() && i === 0) await walletMgr.fundWallets(freshWallets, STATE.fundAmountPerWallet, chatId);
            
            const buyMult = Math.pow(1.3, i / cycles);
            const buyAmt = parseFloat((STATE.minBuyAmount * buyMult * intensity * 0.3).toFixed(4));
            bot.sendMessage(chatId, `🚀 Viral buy ${i + 1}/${cycles}: \`${buyAmt}\` SOL`, { parse_mode: 'Markdown' });
            await BatchSwapEngine.executeBatch(freshWallets, async (w) => await swap(SOL_ADDR, STATE.tokenAddress, w, connection, buyAmt, chatId, true), STATE.batchConcurrency, null, () => STATE.running && !isShuttingDown);
            
            if (i % 2 === 0 && STATE.running && !isShuttingDown) {
                const sellWallets = walletMgr.getWallets(walletCount);
                await BatchSwapEngine.executeBatch(sellWallets, async (w) => { const bal = await getTokenBalance(connection, w.publicKey, STATE.tokenAddress); if (bal > 0) return swap(STATE.tokenAddress, SOL_ADDR, w, connection, parseFloat((bal * 0.1).toFixed(6)), chatId, true); return null; }, STATE.batchConcurrency, null, () => STATE.running && !isShuttingDown);
            }
            if (walletMgr.isEphemeral()) await walletMgr.drainWallets(freshWallets, chatId);
            await sleep(getJitteredInterval(2000, STATE.jitterPercentage));
        }
    }
    else if (mode === 'ORGANIC_GROWTH') {
        const cycles = Math.floor(10 + intensity);
        for (let i = 0; i < cycles && STATE.running && !isShuttingDown; i++) {
            const walletMgr = new WalletManager(walletPool, masterKeypair, connection);
            const randomWallets = walletMgr.getWallets(Math.max(1, Math.floor(walletCount * 0.2)));
            if (walletMgr.isEphemeral() && i === 0) await walletMgr.fundWallets(randomWallets, STATE.fundAmountPerWallet, chatId);
            
            const buyAmt = parseFloat(getRandomFloat(STATE.minBuyAmount, STATE.maxBuyAmount).toFixed(4));
            bot.sendMessage(chatId, `🌱 Organic buy ${i + 1}/${cycles}: \`${buyAmt}\` SOL`, { parse_mode: 'Markdown' });
            await BatchSwapEngine.executeBatch(randomWallets, async (w) => await swap(SOL_ADDR, STATE.tokenAddress, w, connection, buyAmt, chatId, true), STATE.batchConcurrency, null, () => STATE.running && !isShuttingDown);
            
            const pause = getJitteredInterval(5000 + intensity * 2000, 50);
            await sleep(pause);
            
            if (Math.random() < 0.2 && STATE.running && !isShuttingDown) {
                const sellWallets = walletMgr.getWallets(randomWallets.length);
                await BatchSwapEngine.executeBatch(sellWallets, async (w) => { const bal = await getTokenBalance(connection, w.publicKey, STATE.tokenAddress); if (bal > 0) return swap(STATE.tokenAddress, SOL_ADDR, w, connection, parseFloat((bal * 0.15).toFixed(6)), chatId, true); return null; }, STATE.batchConcurrency, null, () => STATE.running && !isShuttingDown);
            }
            if (walletMgr.isEphemeral()) await walletMgr.drainWallets(randomWallets, chatId);
        }
    }
    else if (mode === 'FOMO_WAVE') {
        const waves = Math.floor(2 + intensity * 0.5);
        for (let wave = 0; wave < waves && STATE.running && !isShuttingDown; wave++) {
            bot.sendMessage(chatId, `🌊 FOMO Wave ${wave + 1}/${waves} - Rapid buys!`, { parse_mode: 'Markdown' });
            const buysPerWave = Math.floor(3 + intensity);
            
            for (let i = 0; i < buysPerWave && STATE.running && !isShuttingDown; i++) {
                const walletMgr = new WalletManager(walletPool, masterKeypair, connection);
                const surgeWallets = walletMgr.getWallets(Math.max(1, Math.floor(walletCount * 0.4)));
                if (walletMgr.isEphemeral() && i === 0 && wave === 0) await walletMgr.fundWallets(surgeWallets, STATE.fundAmountPerWallet, chatId);
                
                const buyAmt = parseFloat(getRandomFloat(STATE.minBuyAmount * 1.5, STATE.maxBuyAmount * 2).toFixed(4));
                await BatchSwapEngine.executeBatch(surgeWallets, async (w) => await swap(SOL_ADDR, STATE.tokenAddress, w, connection, buyAmt, chatId, true), STATE.batchConcurrency, null, () => STATE.running && !isShuttingDown);
                await sleep(1500);
                if (walletMgr.isEphemeral() && i === buysPerWave - 1) await walletMgr.drainWallets(surgeWallets, chatId);
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
            const walletMgr = new WalletManager(walletPool, masterKeypair, connection);
            const ladders = walletMgr.getWallets(Math.max(1, Math.floor(walletCount * 0.3)));
            if (walletMgr.isEphemeral() && i === 0) await walletMgr.fundWallets(ladders, STATE.fundAmountPerWallet, chatId);
            
            const stepMult = 1 + (i / steps) * intensity * 0.4;
            const buyAmt = parseFloat((STATE.minBuyAmount * stepMult).toFixed(4));
            bot.sendMessage(chatId, `🪜 Ladder step ${i + 1}/${steps}: \`${buyAmt}\` SOL`, { parse_mode: 'Markdown' });
            await BatchSwapEngine.executeBatch(ladders, async (w) => await swap(SOL_ADDR, STATE.tokenAddress, w, connection, buyAmt, chatId, true), STATE.batchConcurrency, null, () => STATE.running && !isShuttingDown);
            await sleep(getJitteredInterval(STATE.intervalBetweenActions, STATE.jitterPercentage));
            if (walletMgr.isEphemeral() && i === steps - 1) await walletMgr.drainWallets(ladders, chatId);
        }
    }
    else if (mode === 'WASH_TRADING') {
        const pairs = Math.floor(10 + intensity * 3);
        bot.sendMessage(chatId, `🔄 Wash Trading: ${pairs} pairs`, { parse_mode: 'Markdown' });
        
        for (let i = 0; i < pairs && STATE.running && !isShuttingDown; i++) {
            const walletMgr = new WalletManager(walletPool, masterKeypair, connection);
            const buyers = walletMgr.getWallets(1);
            const sellers = walletMgr.getWallets(1);
            if (walletMgr.isEphemeral() && i === 0) {
                await walletMgr.fundWallets(buyers, STATE.fundAmountPerWallet, chatId);
                await walletMgr.fundWallets(sellers, STATE.fundAmountPerWallet, chatId);
            }
            
            const amt = parseFloat(getRandomFloat(STATE.minBuyAmount * 0.5, STATE.maxBuyAmount * 0.7).toFixed(4));
            await BatchSwapEngine.executeBatch(buyers, async (w) => await swap(SOL_ADDR, STATE.tokenAddress, w, connection, amt, chatId, true), STATE.batchConcurrency, null, () => STATE.running && !isShuttingDown);
            await sleep(getJitteredInterval(2000, 10));
            
            await BatchSwapEngine.executeBatch(sellers, async (w) => { const bal = await getTokenBalance(connection, w.publicKey, STATE.tokenAddress); if (bal > 0) return swap(STATE.tokenAddress, SOL_ADDR, w, connection, 'auto', chatId, true); return null; }, STATE.batchConcurrency, null, () => STATE.running && !isShuttingDown);
            
            if ((i + 1) % 5 === 0) bot.sendMessage(chatId, `🔄 Progress: ${i + 1}/${pairs}`, { parse_mode: 'Markdown' }).catch(() => {});
            await sleep(getJitteredInterval(3000, STATE.jitterPercentage));
            if (walletMgr.isEphemeral() && i === pairs - 1) {
                await walletMgr.drainWallets(buyers, chatId);
                await walletMgr.drainWallets(sellers, chatId);
            }
        }
    }
    
    bot.sendMessage(chatId, `🏁 Trending strategy *${mode}* complete!`, { parse_mode: 'Markdown' });
    return { success: true };
}

// ─────────────────────────────────────────────
// 🌪️ Strategy: Jito MEV Wash (Fixed)
// ─────────────────────────────────────────────
async function executeJitoMevWash(chatId, connection) {
    if (!STATE.useJito) { bot.sendMessage(chatId, `❌ Enable Jito in settings to use MEV Wash!`, { parse_mode: 'Markdown' }); return; }
    const walletCount = STATE.useWalletPool ? Math.min(STATE.walletsPerCycle, walletPool.size) : 1;
    return executeStrategyTemplate(chatId, connection, {
        name: 'JITO MEV Wash', walletCount, fundAmount: STATE.fundAmountPerWallet,
        buyLogic: async (wallet, idx, volMult, conn, cid) => { const amt = parseFloat(getRandomFloat(STATE.minBuyAmount, STATE.maxBuyAmount).toFixed(4)); return await swap(SOL_ADDR, STATE.tokenAddress, wallet, conn, amt, cid, true); },
        sellLogic: async (wallet, idx, volMult, conn, cid) => { await sleep(1000); return await swap(STATE.tokenAddress, SOL_ADDR, wallet, conn, 'auto', cid, true); },
        cycles: STATE.numberOfCycles, interCycleDelay: STATE.intervalBetweenActions, needsFunding: !STATE.useWalletPool, needsDraining: !STATE.useWalletPool
    });
}

// ─────────────────────────────────────────────
// 📱 Strategy: KOL Alpha Call (Fixed)
// ─────────────────────────────────────────────
async function executeKolAlphaCall(chatId, connection) {
    const swarmSize = Math.min(STATE.kolRetailSwarmSize, STATE.useWalletPool ? walletPool.size : 20);
    const walletMgr = new WalletManager(walletPool, masterKeypair, connection);
    
    // Whale buy
    const whaleWallet = walletMgr.getWallets(1)[0];
    const whaleAmt = parseFloat((getRandomFloat(STATE.maxBuyAmount * 2, STATE.maxBuyAmount * 5)).toFixed(4));
    bot.sendMessage(chatId, `🐋 Whale buy: \`${whaleAmt}\` SOL`, { parse_mode: 'Markdown' });
    await swap(SOL_ADDR, STATE.tokenAddress, whaleWallet, connection, whaleAmt, chatId, true);
    await sleep(2000);

    // Retail swarm
    const swarmWallets = walletMgr.getWallets(swarmSize);
    if (walletMgr.isEphemeral()) {
        bot.sendMessage(chatId, `🐟 Funding ${swarmSize} retail wallets...`, { parse_mode: 'Markdown' });
        await walletMgr.fundWallets(swarmWallets, STATE.minBuyAmount + 0.005, chatId);
    }
    bot.sendMessage(chatId, `🚀 Retail FOMO: ${swarmWallets.length} wallets`, { parse_mode: 'Markdown' });
    await BatchSwapEngine.executeBatch(swarmWallets, (w) => { const amt = parseFloat(getRandomFloat(STATE.minBuyAmount * 0.1, STATE.minBuyAmount * 0.8).toFixed(4)); return swap(SOL_ADDR, STATE.tokenAddress, w, connection, amt, chatId, true); }, STATE.batchConcurrency, (p) => { if (p.completed === p.total) bot.sendMessage(chatId, `✅ KOL Call: ${p.successes} retail buys executed`, { parse_mode: 'Markdown' }); }, () => STATE.running && !isShuttingDown);
    
    if (walletMgr.isEphemeral()) await walletMgr.drainWallets(swarmWallets, chatId);
    bot.sendMessage(chatId, `✅ KOL Alpha Call complete!`, { parse_mode: 'Markdown' });
    return { success: true };
}

// ─────────────────────────────────────────────
// 🐻 Strategy: Bull Trap (Fixed)
// ─────────────────────────────────────────────
async function executeBullTrap(chatId, connection) {
    bot.sendMessage(chatId, `🐻 *Bull Trap*\nFake breakout → stealth dump`, { parse_mode: 'Markdown' });
    const walletCount = STATE.useWalletPool ? Math.min(STATE.walletsPerCycle, walletPool.size) : 1;
    const walletMgr = new WalletManager(walletPool, masterKeypair, connection);
    const trapWallet = walletMgr.getWallets(1)[0];
    if (walletMgr.isEphemeral()) await walletMgr.fundWallets([trapWallet], STATE.fundAmountPerWallet + 0.01, chatId);

    // Fake breakout buys
    const steps = Math.floor(getRandomFloat(4, 7));
    for (let i = 0; i < steps && STATE.running && !isShuttingDown; i++) {
        const buyAmt = Math.random() < 0.3 ? getRandomFloat(STATE.minBuyAmount * 1.5, STATE.maxBuyAmount * 2) : getRandomFloat(STATE.minBuyAmount, STATE.maxBuyAmount);
        const finalAmt = parseFloat(buyAmt.toFixed(4));
        bot.sendMessage(chatId, `📈 Bait ${i+1}/${steps}: \`${finalAmt}\` SOL`, { parse_mode: 'Markdown' });
        await swap(SOL_ADDR, STATE.tokenAddress, trapWallet, connection, finalAmt, chatId, true);
        await sleep(getJitteredInterval(Math.floor(getRandomFloat(1000, 4000)), STATE.jitterPercentage));
    }
    if (!STATE.running || isShuttingDown) return;

    // Wait for reaction
    const waitTime = getJitteredInterval(Math.floor(getRandomFloat(5000, 12000)), STATE.jitterPercentage);
    bot.sendMessage(chatId, `⏳ Waiting \`${Math.round(waitTime/1000)}s\` for reaction...`, { parse_mode: 'Markdown' });
    await sleep(waitTime);
    if (!STATE.running || isShuttingDown) return;

    // Dump phase
    const totalTokens = await getTokenBalance(connection, trapWallet.publicKey, STATE.tokenAddress);
    if (totalTokens <= 0) { bot.sendMessage(chatId, `⚠️ No tokens to dump. Aborted.`, { parse_mode: 'Markdown' }); return; }
    const oldSlippage = STATE.slippage; STATE.slippage = STATE.bullTrapSlippage || 20;
    const chunks = Math.floor(getRandomFloat(2, 5)), chunkSize = totalTokens / chunks;
    bot.sendMessage(chatId, `🔴 Dumping \`${totalTokens.toFixed(4)}\` tokens in ${chunks} chunks @ ${STATE.slippage}% slippage`, { parse_mode: 'Markdown' });
    for (let c = 0; c < chunks && STATE.running && !isShuttingDown; c++) {
        const amountToSell = (c === chunks - 1) ? 'auto' : chunkSize.toFixed(6);
        await swap(STATE.tokenAddress, SOL_ADDR, trapWallet, connection, amountToSell, chatId, true);
        if (c < chunks - 1) await sleep(getJitteredInterval(Math.floor(getRandomFloat(500, 2000)), STATE.jitterPercentage));
    }
    STATE.slippage = oldSlippage;
    if (walletMgr.isEphemeral()) await walletMgr.drainWallets([trapWallet], chatId);
    bot.sendMessage(chatId, `✅ Bull Trap complete: dumped in ${chunks} chunks.`, { parse_mode: 'Markdown' });
    return { success: true };
}

// ─────────────────────────────────────────────
// 🎁 Strategy: Social Proof Airdrop (Fixed)
// ─────────────────────────────────────────────
async function executeSocialProofAirdrop(chatId, connection) {
    const wCount = STATE.useWalletPool ? Math.min(STATE.airdropWalletCount, walletPool.size) : Math.min(STATE.airdropWalletCount, 30);
    return executeStrategyTemplate(chatId, connection, {
        name: 'Social Proof Airdrop', walletCount: wCount, fundAmount: 0.015,
        buyLogic: async (w, index, volMult, conn, cid) => { const amt = getRandomFloat(0.0005, 0.01); const txid = await swap(SOL_ADDR, STATE.tokenAddress, w, conn, amt, cid, true); await sleep(getRandomFloat(2000, 8000)); return txid; },
        sellLogic: async () => null, cycles: 1, interCycleDelay: 0, needsFunding: !STATE.useWalletPool, needsDraining: !STATE.useWalletPool
    });
}

// ─────────────────────────────────────────────
// 🎮 Master Engine Controller
// ─────────────────────────────────────────────
async function startEngine(chatId) {
    if (!masterKeypair) { bot.sendMessage(chatId, `❌ No wallet loaded! Add PRIVKEY to .env and restart.`, { parse_mode: 'Markdown' }); return; }
    if (!STATE.tokenAddress) { bot.sendMessage(chatId, `❌ Set Token CA first via ⚙️ Config.`, { parse_mode: 'Markdown' }); return; }
    if (STATE.running) { bot.sendMessage(chatId, `🔄 Already running! Stop first.`, { parse_mode: 'Markdown' }); return; }

    await withStrategyLock(STATE.strategy, async () => {
        try {
            await withRpcFallback(async (connection) => {
                STATE.running = true; saveConfig();
                const balance = await connection.getBalance(masterKeypair.publicKey) / LAMPORTS_PER_SOL;
                const shortAddr = masterKeypair.publicKey.toBase58().slice(0, 8) + '...';
                bot.sendMessage(chatId, `💰 *Master Wallet*\n📍 ${shortAddr}\n💎 Balance: \`${balance.toFixed(4)}\` SOL\n\n🚀 Launching *${STATE.strategy}*...\n📈 Jito: \`${STATE.useJito ? 'ON' : 'OFF'}\` | Vol Curve: \`${STATE.useVolumeCurve ? 'ON' : 'OFF'}\`\n🛡️ Stealth: \`${STATE.fundingStealthLevel === 2 ? 'Multi-hop' : 'Direct'}\``, { parse_mode: 'Markdown' });

                if (balance < 0.001) bot.sendMessage(chatId, `⚠️ *Warning:* Very low SOL balance (\`${balance.toFixed(4)}\`). Operations may fail.`, { parse_mode: 'Markdown' });
                if (balance < STATE.minBuyAmount + STATE.priorityFee + 0.001) { bot.sendMessage(chatId, `❌ *Insufficient SOL:* Need \`${(STATE.minBuyAmount + STATE.priorityFee + 0.001).toFixed(4)}\` SOL minimum.`, { parse_mode: 'Markdown' }); STATE.running = false; return; }

                const strategies = { "STANDARD": executeStandardCycles, "MAKER": executeMakerCycles, "WEB_OF_ACTIVITY": executeWebOfActivity, "SPAM": executeSpamMode, "PUMP_DUMP": executePumpDump, "CHART_PATTERN": executeChartPattern, "HOLDER_GROWTH": executeHolderGrowth, "WHALE": executeWhaleSimulation, "VOLUME_BOOST": executeVolumeBoost, "TRENDING": executeTrendingStrategy, "JITO_MEV_WASH": executeJitoMevWash, "KOL_ALPHA_CALL": executeKolAlphaCall, "BULL_TRAP": executeBullTrap, "SOCIAL_PROOF_AIRDROP": executeSocialProofAirdrop };
                const strategy = strategies[STATE.strategy];
                if (strategy) await strategy(chatId, connection); else throw new Error(`Unknown strategy: ${STATE.strategy}`);
                if (STATE.running && !isShuttingDown) bot.sendMessage(chatId, `🏁 *Strategy Complete!*`, { parse_mode: "Markdown" });
            });
        } catch (e) { logger.error(`[Engine] Fatal error: ${e.message}\n${e.stack}`); bot.sendMessage(chatId, `⚠️ Engine Error: ${e.message}`, { parse_mode: 'Markdown' }).catch(() => {}); }
        finally { STATE.running = false; saveConfig(); }
    }, chatId);
}

// ─────────────────────────────────────────────
// 🎛️ Telegram UI: Main Menu
// ─────────────────────────────────────────────
function showMainMenu(chatId) {
    const statusIcon = STATE.running ? '🟢' : '🔴';
    const statusText = STATE.running ? 'RUNNING' : 'IDLE';
    
    bot.sendMessage(chatId,
        `╔═══════════════════════╗\n` +
        `║  🤖 *Volume Bot v3.1*  ║\n` +
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
        `❓ *Volume Bot v3.1 - Help*\n\n` +
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
                const walletMgr = new WalletManager(walletPool, masterKeypair, connection);
                await walletMgr.fundWallets(walletPool.wallets || [], STATE.fundAmountPerWallet, chatId);
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
                const walletMgr = new WalletManager(walletPool, masterKeypair, connection);
                await walletMgr.drainWallets(walletPool.wallets || [], chatId);
                showWalletPoolMenu(chatId);
            });
        });
    }
    else if (action === 'pool_scan') {
        if (walletPool.size === 0) return bot.sendMessage(chatId, `❌ No wallets.`);
        
        await withRpcFallback(async (connection) => {
            bot.sendMessage(chatId, `📊 Scanning ${walletPool.size} wallets...`);
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
logger.info(`🚀 Volume Bot v3.1 started | Strategies: 14 | Pool: ${walletPool.size.toLocaleString()} wallets`);
logger.info(`🌐 RPC Endpoints: ${RPC_URLS.length} | Jito: ${STATE.useJito ? 'ON' : 'OFF'} | Stealth: Level ${STATE.fundingStealthLevel}`);

// Export for testing
export { STATE, walletPool, swap, sendSOL, getTokenBalance, WalletManager };
