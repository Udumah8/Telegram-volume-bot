// jito.js
import { PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL, Keypair, Connection } from "@solana/web3.js";
import axios from "axios";
import bs58 from "bs58";

// ─────────────────────────────────────────────
// 🌐 Jito Configuration Constants
// ─────────────────────────────────────────────

/**
 * Jito tip accounts (rotated periodically by Jito)
 * Source: https://jito-labs.gitbook.io/mev/searcher-resources/getting-started/bundles
 */
export const JITO_TIP_ACCOUNTS = [
    "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5", // Mainnet
    "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
    "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY", // Primary
    "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
    "DfXygSm4jMsMottyyAcSxbx2pW4koZRX5EEtGsETrxLp",
    "ADuUkR4wAptGqCrmz2TF6rsuN9LwFj1D3jVf2ZrtJqZ5",
    "DttWaM2x9WeG6KxLgZgP1H7E4tQyLZ1M4tQhVfP1U2gC",
    "3AVi9UrgV4bKAZQ3C7c6Nn4ZgRk1Nq8E8iFfTQf1p5fL"
];

/**
 * Jito Block Engine endpoints (regional for lower latency)
 */
export const JITO_BLOCK_ENGINES = [
    "https://mainnet.block-engine.jito.wtf/api/v1/bundles",           // Default
    "https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles", // EU
    "https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles", // EU Central
    "https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles",        // US East
    "https://tokyo.mainnet.block-engine.jito.wtf/api/v1/bundles"      // Asia
];

/**
 * Jito Relay endpoints for bundle status checking
 */
export const JITO_RELAY_ENDPOINTS = [
    "https://mainnet.block-engine.jito.wtf/api/v1/relay",
    "https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/relay",
    "https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/relay",
    "https://ny.mainnet.block-engine.jito.wtf/api/v1/relay",
    "https://tokyo.mainnet.block-engine.jito.wtf/api/v1/relay"
];

// ─────────────────────────────────────────────
// ⚙️ Configuration & Defaults
// ─────────────────────────────────────────────

const DEFAULT_CONFIG = {
    timeoutMs: 15000,           // Request timeout
    maxRetries: 3,              // Retry attempts for transient errors
    retryDelayMs: 1000,         // Base delay between retries
    tipAccountRotation: true,   // Rotate tip accounts randomly
    endpointRotation: true,     // Rotate block engine endpoints
    authRequired: false,        // Whether auth keypair is required
    bundleStatusCheck: true,    // Check bundle status after sending
    statusCheckIntervalMs: 2000,// Interval for status polling
    statusCheckMaxAttempts: 10  // Max polling attempts
};

// ─────────────────────────────────────────────
// 🔐 Jito Authentication Helper
// ─────────────────────────────────────────────

/**
 * Parse Jito auth keypair from environment variable or config
 * Supports JSON array format or base58-encoded secret key
 * 
 * @param {string} authKeyInput - Auth keypair string
 * @returns {Keypair|null} Parsed Keypair or null if invalid
 */
export function parseJitoAuthKeypair(authKeyInput) {
    if (!authKeyInput) return null;
    
    try {
        // Try JSON array format first: [1,2,3,...,64]
        if (authKeyInput.trim().startsWith('[')) {
            const secretKey = Uint8Array.from(JSON.parse(authKeyInput));
            return Keypair.fromSecretKey(secretKey);
        }
        
        // Try base58-encoded secret key
        if (authKeyInput.length === 88) { // Base58 encoded 64-byte key
            const secretKey = bs58.decode(authKeyInput);
            return Keypair.fromSecretKey(secretKey);
        }
        
        // Try file path (advanced usage)
        if (authKeyInput.startsWith('/') || authKeyInput.startsWith('./')) {
            const fs = await import('fs');
            const fileContent = fs.readFileSync(authKeyInput, 'utf-8');
            return parseJitoAuthKeypair(fileContent);
        }
        
        console.warn('[Jito] Auth key format not recognized');
        return null;
        
    } catch (err) {
        console.error(`[Jito] Failed to parse auth keypair: ${err.message}`);
        return null;
    }
}

// ─────────────────────────────────────────────
// 📡 Jito API Client
// ─────────────────────────────────────────────

/**
 * Create axios instance with Jito-specific defaults
 */
function createJitoClient(timeoutMs = DEFAULT_CONFIG.timeoutMs) {
    return axios.create({
        timeout: timeoutMs,
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'solana-volume-bot/3.1.0'
        },
        validateStatus: (status) => status < 500 // Handle 4xx manually
    });
}

/**
 * Select endpoint with optional rotation for load distribution
 */
function selectEndpoint(endpoints, useRotation = true) {
    if (!useRotation || endpoints.length === 1) {
        return endpoints[0];
    }
    // Weighted random: prefer first endpoint but allow fallback
    if (Math.random() < 0.7) {
        return endpoints[0];
    }
    return endpoints[Math.floor(Math.random() * endpoints.length)];
}

// ─────────────────────────────────────────────
// 🌪️ Main Bundle Sender Function
// ─────────────────────────────────────────────

/**
 * Creates and sends a Jito bundle containing the provided transactions plus a tip transaction.
 * 
 * @param {Array<string>} b58Txs - Array of base58 encoded transactions (already signed by user).
 * @param {Keypair} feePayer - Keypair paying the Jito tip.
 * @param {Connection} connection - Solana connection for blockhash and balance checks.
 * @param {number} tipAmountSol - Tip amount in SOL (recommended: 0.0001 - 0.01 SOL).
 * @param {Object} options - Optional configuration overrides.
 * @param {string} [options.authKeypair] - Jito auth keypair for authenticated endpoints.
 * @param {number} [options.timeoutMs] - Request timeout in milliseconds.
 * @param {number} [options.maxRetries] - Max retry attempts for transient errors.
 * @param {boolean} [options.checkBalance] - Verify feePayer has sufficient balance before sending.
 * @param {boolean} [options.waitForConfirmation] - Poll for bundle confirmation after sending.
 * @returns {Promise<{bundleId: string|null, success: boolean, error?: string, tipTxid?: string}>}
 */
export async function sendJitoBundle(
    b58Txs, 
    feePayer, 
    connection, 
    tipAmountSol, 
    options = {}
) {
    // Merge defaults with user options
    const config = { ...DEFAULT_CONFIG, ...options };
    
    const result = {
        bundleId: null,
        success: false,
        error: null,
        tipTxid: null,
        endpoint: null,
        attempts: 0
    };

    try {
        // ─── Pre-flight Checks ─────────────────
        
        // Validate inputs
        if (!Array.isArray(b58Txs) || b58Txs.length === 0) {
            throw new Error('b58Txs must be a non-empty array of base58-encoded transactions');
        }
        if (!feePayer?.publicKey) {
            throw new Error('feePayer must be a valid Keypair with publicKey');
        }
        if (!connection) {
            throw new Error('connection must be a valid Solana Connection instance');
        }
        if (typeof tipAmountSol !== 'number' || tipAmountSol <= 0) {
            throw new Error('tipAmountSol must be a positive number');
        }

        // Check feePayer balance if requested
        if (config.checkBalance !== false) {
            const requiredLamports = Math.floor(tipAmountSol * LAMPORTS_PER_SOL) + 10000; // Buffer for fees
            const balance = await connection.getBalance(feePayer.publicKey, 'confirmed');
            
            if (balance < requiredLamports) {
                throw new Error(
                    `Insufficient balance for Jito tip: ${balance / LAMPORTS_PER_SOL} SOL ` +
                    `< ${(tipAmountSol + 0.00001).toFixed(5)} SOL required`
                );
            }
        }

        // ─── Create Tip Transaction ────────────
        
        // Select tip account (random rotation for distribution)
        const tipAccountStr = config.tipAccountRotation 
            ? JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]
            : JITO_TIP_ACCOUNTS[2]; // Default to primary
        
        const tipAccount = new PublicKey(tipAccountStr);
        
        // Get fresh blockhash for tip transaction
        const latestBlockhash = await connection.getLatestBlockhash('confirmed');
        
        // Create tip instruction
        const tipTx = new Transaction().add(
            SystemProgram.transfer({
                fromPubkey: feePayer.publicKey,
                toPubkey: tipAccount,
                lamports: Math.floor(tipAmountSol * LAMPORTS_PER_SOL)
            })
        );
        
        tipTx.recentBlockhash = latestBlockhash.blockhash;
        tipTx.feePayer = feePayer.publicKey;
        tipTx.sign(feePayer);
        
        // Serialize tip transaction
        const b58TipTx = bs58.encode(tipTx.serialize());
        result.tipTxid = tipTx.signatures[0]?.signature 
            ? bs58.encode(tipTx.signatures[0].signature) 
            : null;

        // ─── Build Bundle ──────────────────────
        
        // Bundle order: user transactions first, tip transaction last
        // Jito processes bundles in order; tip at end ensures validators see it after user txs
        const bundleTxs = [...b58Txs, b58TipTx];

        // ─── Prepare Auth Headers ──────────────
        
        const headers = { 'Content-Type': 'application/json' };
        
        // Add authentication if provided
        if (config.authKeypair || process.env.JITO_AUTH_KEYPAIR) {
            const authInput = config.authKeypair || process.env.JITO_AUTH_KEYPAIR;
            const authKeypair = parseJitoAuthKeypair(authInput);
            
            if (authKeypair) {
                // Jito uses the auth pubkey as a simple bearer token
                headers['Authorization'] = `Bearer ${authKeypair.publicKey.toBase58()}`;
                console.debug(`[Jito] Authenticated as ${authKeypair.publicKey.toBase58().slice(0,8)}...`);
            } else {
                console.warn('[Jito] Auth keypair provided but failed to parse - sending unauthenticated');
            }
        }

        // ─── Send Bundle with Retry Logic ──────
        
        const client = createJitoClient(config.timeoutMs);
        let lastError = null;
        
        for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
            result.attempts = attempt + 1;
            
            try {
                // Select endpoint (with optional rotation)
                const endpoint = selectEndpoint(JITO_BLOCK_ENGINES, config.endpointRotation);
                result.endpoint = endpoint;
                
                // Build JSON-RPC request
                const requestBody = {
                    jsonrpc: "2.0",
                    id: `bundle_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                    method: "sendBundle",
                    params: [bundleTxs]
                };
                
                console.debug(
                    `[Jito] Sending bundle: ${b58Txs.length} txs + tip ` +
                    `(${tipAmountSol} SOL) to ${endpoint.replace('https://', '').split('/')[0]} ` +
                    `(attempt ${attempt + 1}/${config.maxRetries + 1})`
                );
                
                // POST to Jito Block Engine
                const response = await client.post(endpoint, requestBody, { headers });
                
                // Handle response
                if (response.data?.result) {
                    result.bundleId = response.data.result;
                    result.success = true;
                    
                    console.log(
                        `[Jito] ✅ Bundle sent successfully: ${result.bundleId} ` +
                        `| Tip: ${tipAmountSol} SOL | Endpoint: ${result.endpoint}`
                    );
                    
                    // Optional: wait for bundle confirmation
                    if (config.waitForConfirmation && result.bundleId) {
                        const confirmed = await waitForBundleConfirmation(
                            result.bundleId,
                            connection,
                            {
                                intervalMs: config.statusCheckIntervalMs,
                                maxAttempts: config.statusCheckMaxAttempts,
                                endpoint: selectEndpoint(JITO_RELAY_ENDPOINTS, config.endpointRotation)
                            }
                        );
                        result.confirmed = confirmed;
                        
                        if (confirmed) {
                            console.log(`[Jito] ✅ Bundle ${result.bundleId} confirmed on-chain`);
                        } else {
                            console.warn(`[Jito] ⚠️ Bundle ${result.bundleId} not confirmed within timeout`);
                        }
                    }
                    
                    return result;
                    
                } else if (response.data?.error) {
                    // Jito returned an error response
                    const error = response.data.error;
                    lastError = new Error(`Jito API error: ${error.message || JSON.stringify(error)}`);
                    lastError.code = error.code;
                    lastError.data = error.data;
                    
                    console.warn(`[Jito] API error (attempt ${attempt + 1}): ${error.message}`);
                    
                    // Determine if retryable
                    if (!isJitoErrorRetryable(error) || attempt >= config.maxRetries) {
                        break; // Don't retry non-retryable errors
                    }
                    
                } else {
                    // Unexpected response format
                    lastError = new Error(`Unexpected Jito response: ${JSON.stringify(response.data).slice(0, 200)}`);
                    console.warn(`[Jito] Unexpected response: ${JSON.stringify(response.data).slice(0, 200)}`);
                }
                
            } catch (err) {
                lastError = err;
                
                // Log error details
                const errorMsg = err.message || 'Unknown error';
                const isNetworkError = err.code === 'ECONNABORTED' || 
                                      err.code === 'ETIMEDOUT' || 
                                      err.code === 'ECONNRESET' ||
                                      !err.response;
                
                console.warn(
                    `[Jito] Request failed (attempt ${attempt + 1}): ${errorMsg}` +
                    (isNetworkError ? ' [Network/Timeout]' : '')
                );
                
                // Determine if retryable
                if (!isJitoErrorRetryable(err) || attempt >= config.maxRetries) {
                    break;
                }
            }
            
            // Exponential backoff before retry
            if (attempt < config.maxRetries) {
                const delay = config.retryDelayMs * Math.pow(2, attempt);
                const jitter = delay * 0.1 * Math.random();
                const totalDelay = Math.min(delay + jitter, 5000);
                
                console.debug(`[Jito] Retrying in ${Math.round(totalDelay)}ms...`);
                await new Promise(resolve => setTimeout(resolve, totalDelay));
            }
        }
        
        // ─── All Retries Exhausted ─────────────
        
        result.error = lastError?.message || 'Failed to send Jito bundle after all retries';
        result.errorCode = lastError?.code;
        result.errorData = lastError?.data;
        
        console.error(
            `[Jito] ❌ Bundle send failed after ${result.attempts} attempt(s): ${result.error}`
        );
        
        return result;
        
    } catch (err) {
        // Catch-all for unexpected errors
        result.error = err.message || 'Unexpected error in sendJitoBundle';
        result.success = false;
        
        console.error(`[Jito] ❌ Critical error: ${result.error}`);
        if (err.stack) console.debug(err.stack);
        
        return result;
    }
}

// ─────────────────────────────────────────────
// 🔍 Bundle Status Checking
// ─────────────────────────────────────────────

/**
 * Poll Jito Relay to check if a bundle was landed on-chain
 * 
 * @param {string} bundleId - Bundle ID returned from sendBundle
 * @param {Connection} connection - Solana connection for on-chain verification
 * @param {Object} options - Polling configuration
 * @returns {Promise<boolean>} True if bundle was confirmed, false otherwise
 */
export async function waitForBundleConfirmation(bundleId, connection, options = {}) {
    const {
        intervalMs = 2000,
        maxAttempts = 10,
        endpoint = JITO_RELAY_ENDPOINTS[0]
    } = options;
    
    if (!bundleId) return false;
    
    const client = createJitoClient(5000); // Short timeout for polling
    
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            // Check bundle status via Jito Relay
            const statusResponse = await client.post(endpoint, {
                jsonrpc: "2.0",
                id: `status_${Date.now()}`,
                method: "getBundleStatuses",
                params: [[bundleId]]
            }, {
                headers: { 'Content-Type': 'application/json' }
            });
            
            const bundleStatus = statusResponse.data?.result?.value?.[0];
            
            if (bundleStatus) {
                // Bundle found in Jito system
                if (bundleStatus.confirmation_status === 'confirmed' || 
                    bundleStatus.confirmation_status === 'finalized' ||
                    bundleStatus.transactions?.length > 0) {
                    
                    // Verify on-chain by checking if any transaction in bundle was confirmed
                    const txSignatures = bundleStatus.transactions?.map(tx => tx.signature) || [];
                    
                    for (const sig of txSignatures) {
                        try {
                            const status = await connection.getSignatureStatus(sig, { searchTransactionHistory: true });
                            if (status?.value?.confirmationStatus === 'confirmed' || 
                                status?.value?.confirmationStatus === 'finalized') {
                                return true;
                            }
                        } catch {
                            // Continue checking other signatures
                        }
                    }
                    
                    // If we can't verify on-chain but Jito says confirmed, trust Jito
                    if (bundleStatus.confirmation_status === 'confirmed') {
                        return true;
                    }
                }
                
                // If bundle was rejected, stop polling
                if (bundleStatus.confirmation_status === 'failed' || 
                    bundleStatus.confirmation_status === 'dropped') {
                    console.debug(`[Jito] Bundle ${bundleId} status: ${bundleStatus.confirmation_status}`);
                    return false;
                }
            }
            
        } catch (err) {
            // Network errors during polling are non-fatal - continue polling
            console.debug(`[Jito] Status check attempt ${attempt + 1} failed: ${err.message}`);
        }
        
        // Wait before next poll (except on last attempt)
        if (attempt < maxAttempts - 1) {
            await new Promise(resolve => setTimeout(resolve, intervalMs));
        }
    }
    
    // Max attempts reached without confirmation
    console.debug(`[Jito] Bundle ${bundleId} not confirmed after ${maxAttempts} polling attempts`);
    return false;
}

// ─────────────────────────────────────────────
// 🧠 Error Classification Helpers
// ─────────────────────────────────────────────

/**
 * Determine if a Jito API error is retryable
 * @param {Object|Error} error - Error object or Jito error response
 * @returns {boolean} True if error should trigger retry
 */
export function isJitoErrorRetryable(error) {
    if (!error) return false;
    
    // Handle axios error objects
    if (error.code) {
        const networkCodes = ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN'];
        if (networkCodes.includes(error.code)) return true;
    }
    
    // Handle Jito API error responses
    if (error.code !== undefined) {
        // Retryable Jito error codes
        const retryableCodes = [
            -32001, // Server busy / rate limited
            -32002, // Transaction preflight failed (may be transient)
            -32004, // Blockhash not found (retry with new blockhash)
            -32603  // Internal error (may be transient)
        ];
        if (retryableCodes.includes(error.code)) return true;
        
        // Non-retryable codes
        const nonRetryableCodes = [
            -32600, // Invalid request (won't succeed with retry)
            -32601, // Method not found
            -32602, // Invalid params
            -32700  // Parse error
        ];
        if (nonRetryableCodes.includes(error.code)) return false;
    }
    
    // Check message for retryable patterns
    const message = (error.message || '').toLowerCase();
    
    if (message.includes('timeout') || 
        message.includes('rate limit') || 
        message.includes('429') ||
        message.includes('server busy') ||
        message.includes('try again') ||
        message.includes('temporarily unavailable')) {
        return true;
    }
    
    if (message.includes('invalid') && !message.includes('blockhash')) {
        return false; // Invalid requests won't succeed with retry
    }
    
    // Default: assume transient errors are retryable
    return true;
}

// ─────────────────────────────────────────────
// 🧪 Utility Functions
// ─────────────────────────────────────────────

/**
 * Estimate appropriate tip amount based on network conditions
 * @param {Connection} connection - Solana connection
 * @param {number} baseTipSol - Base tip amount (default: 0.001)
 * @returns {Promise<number>} Recommended tip amount in SOL
 */
export async function estimateJitoTip(connection, baseTipSol = 0.001) {
    try {
        // Get recent priority fees as proxy for network congestion
        const priorityFees = await connection.getRecentPrioritizationFees();
        
        if (!priorityFees?.length) {
            return baseTipSol;
        }
        
        // Calculate median prioritization fee
        const fees = priorityFees.map(p => p.prioritizationFee).filter(f => f > 0);
        if (fees.length === 0) return baseTipSol;
        
        fees.sort((a, b) => a - b);
        const medianFee = fees[Math.floor(fees.length / 2)];
        
        // Scale tip based on median fee (higher fees = more congestion = higher tip)
        // Base: 0.001 SOL at 0 microLamports, scale up to 0.01 SOL at 100,000+ microLamports
        const scaledTip = baseTipSol * (1 + Math.min(medianFee / 10000, 10));
        
        return Math.min(Math.max(scaledTip, baseTipSol * 0.5), baseTipSol * 15);
        
    } catch (err) {
        console.debug(`[Jito] Tip estimation failed: ${err.message}, using base tip`);
        return baseTipSol;
    }
}

/**
 * Validate that a base58 string is a properly formatted transaction
 * @param {string} b58Tx - Base58 encoded transaction
 * @returns {boolean} True if valid format
 */
export function isValidB58Transaction(b58Tx) {
    if (typeof b58Tx !== 'string' || b58Tx.length < 100) return false;
    
    try {
        const decoded = bs58.decode(b58Tx);
        // Solana transactions are typically 200-2000 bytes
        return decoded.length >= 100 && decoded.length <= 5000;
    } catch {
        return false;
    }
}

/**
 * Get Jito configuration status for debugging
 * @returns {Object} Configuration summary
 */
export function getJitoConfigStatus() {
    const authKey = process.env.JITO_AUTH_KEYPAIR ? 'SET' : 'NOT SET';
    const authParsed = parseJitoAuthKeypair(process.env.JITO_AUTH_KEYPAIR) ? 'VALID' : 'INVALID/MISSING';
    
    return {
        tipAccounts: JITO_TIP_ACCOUNTS.length,
        blockEngines: JITO_BLOCK_ENGINES.length,
        relayEndpoints: JITO_RELAY_ENDPOINTS.length,
        authKeyStatus: authKey,
        authKeyParsed: authParsed,
        defaults: DEFAULT_CONFIG
    };
}

// ─────────────────────────────────────────────
// 🎯 Convenience Wrapper: Send Single Transaction
// ─────────────────────────────────────────────

/**
 * Convenience function to send a single transaction via Jito
 * 
 * @param {Transaction} tx - Unsigned or partially signed transaction
 * @param {Keypair} signer - Keypair to sign the transaction
 * @param {Connection} connection - Solana connection
 * @param {number} tipAmountSol - Tip amount in SOL
 * @param {Object} options - Options for sendJitoBundle
 * @returns {Promise<{bundleId: string|null, success: boolean, txid?: string, error?: string}>}
 */
export async function sendSingleTxViaJito(tx, signer, connection, tipAmountSol, options = {}) {
    try {
        // Get fresh blockhash
        const { blockhash } = await connection.getLatestBlockhash('confirmed');
        tx.recentBlockhash = blockhash;
        tx.feePayer = signer.publicKey;
        
        // Sign transaction
        tx.sign(signer);
        
        // Serialize to base58
        const b58Tx = bs58.encode(tx.serialize());
        
        // Send via Jito bundle
        const result = await sendJitoBundle([b58Tx], signer, connection, tipAmountSol, options);
        
        return {
            bundleId: result.bundleId,
            success: result.success,
            txid: result.tipTxid, // Note: this is the tip txid, not user tx
            error: result.error
        };
        
    } catch (err) {
        return {
            bundleId: null,
            success: false,
            txid: null,
            error: err.message
        };
    }
}

// ─────────────────────────────────────────────
// 📦 Module Exports
// ─────────────────────────────────────────────

export default {
    sendJitoBundle,
    sendSingleTxViaJito,
    waitForBundleConfirmation,
    estimateJitoTip,
    parseJitoAuthKeypair,
    isJitoErrorRetryable,
    isValidB58Transaction,
    getJitoConfigStatus,
    // Constants
    JITO_TIP_ACCOUNTS,
    JITO_BLOCK_ENGINES,
    JITO_RELAY_ENDPOINTS,
    DEFAULT_CONFIG
};
