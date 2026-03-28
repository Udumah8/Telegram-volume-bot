import { PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import axios from "axios";
import bs58 from "bs58";

const JITO_TIP_ACCOUNTS = [
    "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
    "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
    "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvVkY",
    "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
    "DfXygSm4jMsMottyyAcSxbx2pW4koZRX5EEtGsETrxLp",
    "ADuUkR4wAptGqCrmz2TF6rsuN9LwFj1D3jVf2ZrtJqZ5",
    "DttWaM2x9WeG6KxLgZgP1H7E4tQyLZ1M4tQhVfP1U2gC",
    "3AVi9UrgV4bKAZQ3C7c6Nn4ZgRk1Nq8E8iFfTQf1p5fL"
];

const JITO_BLOCK_ENGINES = [
    "https://mainnet.block-engine.jito.wtf/api/v1/bundles",
    "https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles",
    "https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles",
    "https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles",
    "https://tokyo.mainnet.block-engine.jito.wtf/api/v1/bundles"
];

/**
 * Creates and sends a Jito bundle containing the provided transactions plus a tip transaction.
 * @param {Array<string>} b58Txs - Array of base58 encoded transactions (already signed by the user).
 * @param {Keypair} feePayer - Keypair paying the Jito tip.
 * @param {Connection} connection - Solana connection.
 * @param {number} tipAmountSol - Tip amount in SOL.
 * @returns {string|null} Bundle ID or null if failed.
 */
export async function sendJitoBundle(b58Txs, feePayer, connection, tipAmountSol) {
    try {
        // Create Tip Transaction
        const tipAccountStr = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
        const tipAccount = new PublicKey(tipAccountStr);
        
        const latestBlockhash = await connection.getLatestBlockhash('confirmed');
        
        const tipTx = new Transaction().add(
            SystemProgram.transfer({
                fromPubkey: feePayer.publicKey,
                toPubkey: tipAccount,
                lamports: Math.floor(tipAmountSol * LAMPORTS_PER_SOL),
            })
        );
        tipTx.recentBlockhash = latestBlockhash.blockhash;
        tipTx.feePayer = feePayer.publicKey;
        tipTx.sign(feePayer);
        
        const b58TipTx = bs58.encode(tipTx.serialize());
        
        // Final bundle: user txs + tip tx at the end
        const bundleTxs = [...b58Txs, b58TipTx];

        // Send to Jito
        const jitoEngine = JITO_BLOCK_ENGINES[Math.floor(Math.random() * JITO_BLOCK_ENGINES.length)];
        
        const requestBody = {
            jsonrpc: "2.0",
            id: 1,
            method: "sendBundle",
            params: [
                bundleTxs
            ]
        };

        const response = await axios.post(jitoEngine, requestBody, {
            headers: { 'Content-Type': 'application/json' }
        });

        if (response.data && response.data.result) {
            const bundleId = response.data.result;
            return bundleId;
        } else {
            console.error("Jito Bundle Error:", response.data);
            return null;
        }
    } catch (e) {
        console.error("Failed to send Jito bundle:", e.message);
        if (e.response && e.response.data) {
            console.error("Jito response:", e.response.data);
        }
        return null;
    }
}
