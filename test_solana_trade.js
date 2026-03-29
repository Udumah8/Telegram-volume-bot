try {
    const { SolanaTrade } = await import("solana-trade");
    console.log("✅ SolanaTrade load OK!");
    // eslint-disable-next-line no-unused-vars
    const st = new SolanaTrade();
    console.log("✅ SolanaTrade instance OK!");
} catch (e) {
    console.error("❌ SolanaTrade load FAILED:", e.message);
}
