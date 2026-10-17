import { test } from "node:test";
import assert from "node:assert/strict";
import { LendingMath } from "@qmoosa/lending-protocol";
import { LendingEngine } from "@qmoosa/lending-engine";
import { QmoosaLendingClient } from "@qmoosa/lending-sdk";

function initializeTestWorld() {
  const engine = new LendingEngine();
  engine.registerReserve({
    symbol: "WETH",
    decimals: 18,
    totalDepositedUsd: 0n,
    totalBorrowedUsd: 0n,
    ltvBps: 8000,               // 80% LTV
    liquidationThresholdBps: 8500, // 85% Liquidation Threshold
    liquidationBonusBps: 500,   // 5% Liquidation Bonus
    baseRateBps: 200,
    optimalUtilizationBps: 8000,
    rateSlope1Bps: 400,
    rateSlope2Bps: 6000
  });
  engine.registerReserve({
    symbol: "USDC",
    decimals: 6,
    totalDepositedUsd: 0n,
    totalBorrowedUsd: 0n,
    ltvBps: 8000,
    liquidationThresholdBps: 8500,
    liquidationBonusBps: 500,
    baseRateBps: 200,
    optimalUtilizationBps: 8000,
    rateSlope1Bps: 400,
    rateSlope2Bps: 6000
  });

  const client = new QmoosaLendingClient({
    chainAdapter: {
      broadcast: async (payload) => ({
        txHash: "0x7777777777777777777777777777777777777777777777777777777777777777",
        status: "CONFIRMED"
      })
    }
  });

  return { engine, client };
}

test("1. Cross-Component Initialization & Reserve Configuration", () => {
  const { engine } = initializeTestWorld();
  const weth = engine.getReserve("WETH");
  const usdc = engine.getReserve("USDC");

  assert.equal(weth.symbol, "WETH");
  assert.equal(usdc.symbol, "USDC");
  assert.equal(weth.ltvBps, 8000);
});

test("2. End-to-End Deposit & Borrow Workflow via SDK Payload Execution", async () => {
  const { engine, client } = initializeTestWorld();

  // Liquidity provider supplies 100,000 USDC
  const depositLenderPayload = client.buildDepositPayload("0xlender", "USDC", 100_000n);
  const receipt1 = await client.broadcast(depositLenderPayload);
  assert.equal(receipt1.status, "CONFIRMED");
  engine.deposit(depositLenderPayload.user, depositLenderPayload.asset, depositLenderPayload.amount);

  // Alice deposits 20,000 WETH collateral
  const depositAlicePayload = client.buildDepositPayload("0xalice", "WETH", 20_000n);
  engine.deposit(depositAlicePayload.user, depositAlicePayload.asset, depositAlicePayload.amount);

  // Alice checks health factor before borrowing
  const healthBefore = engine.getAccountHealth("0xalice");
  assert.equal(healthBefore.totalCollateralUsd, 20_000n);
  assert.equal(healthBefore.maxBorrowUsd, 16_000n); // 80% of 20,000

  // Alice borrows 10,000 USDC
  const borrowPayload = client.buildBorrowPayload("0xalice", "USDC", 10_000n);
  engine.borrow(borrowPayload.user, borrowPayload.asset, borrowPayload.amount);

  const healthAfter = engine.getAccountHealth("0xalice");
  assert.equal(healthAfter.totalDebtUsd, 10_000n);
  // Weighted collateral = 20,000 * 85% = 17,000. HF = 17,000 / 10,000 = 1.7 (17,000 bps)
  assert.equal(healthAfter.healthFactor, 17000);
  assert.equal(healthAfter.isLiquidatable, false);
});

test("3. Adversarial Attack 1: Over-borrowing exceeding maximum LTV is strictly rejected", () => {
  const { engine, client } = initializeTestWorld();
  engine.deposit("0xlender", "USDC", 100_000n);
  engine.deposit("0xattacker", "WETH", 10_000n); // max borrow = $8,000

  const excessiveBorrow = client.buildBorrowPayload("0xattacker", "USDC", 8500n);
  assert.throws(
    () => engine.borrow(excessiveBorrow.user, excessiveBorrow.asset, excessiveBorrow.amount),
    /Borrow exceeds maximum collateral borrowing capacity/
  );
});

test("4. Adversarial Attack 2: Premature liquidation of safe account is strictly reverted", () => {
  const { engine, client } = initializeTestWorld();
  engine.deposit("0xlender", "USDC", 100_000n);
  engine.deposit("0xalice", "WETH", 20_000n);
  engine.borrow("0xalice", "USDC", 10_000n); // HF = 1.7 (Safe)

  const liqPayload = client.buildLiquidationPayload("0xpredator", "0xalice", "USDC", 5000n, "WETH");
  assert.throws(
    () => engine.liquidate(liqPayload.user, liqPayload.borrower, liqPayload.asset, liqPayload.debtToCover, liqPayload.collateralAsset),
    /Account is not eligible for liquidation/
  );
});

test("5. Real Liquidation: Under-collateralized borrower is liquidated and rewards liquidator", () => {
  const { engine, client } = initializeTestWorld();
  engine.deposit("0xlender", "USDC", 100_000n);
  engine.deposit("0xborrower", "WETH", 10_000n);
  engine.borrow("0xborrower", "USDC", 8000n); // Borrow $8,000

  // Collateral drops in value by 20% (simulated market drop)
  // Deposits become $8,000. Weighted collateral = $8,000 * 0.85 = $6,800. Debt = $8,000. HF = 0.85 < 1.0!
  const pos = engine["positions"].get("0xborrower");
  pos.deposits.set("WETH", 8000n);

  const health = engine.getAccountHealth("0xborrower");
  assert.equal(health.isLiquidatable, true);

  // Liquidator repays $4,000 of debt
  const liqPayload = client.buildLiquidationPayload("0xliquidator", "0xborrower", "USDC", 4000n, "WETH");
  const result = engine.liquidate(
    liqPayload.user,
    liqPayload.borrower,
    liqPayload.asset,
    liqPayload.debtToCover,
    liqPayload.collateralAsset
  );

  assert.equal(result.repaidDebtUsd, 4000n);
  // Seized = 4000 * 1.05 = 4200
  assert.equal(result.seizedCollateralUsd, 4200n);

  // Liquidator receives 4,200 WETH collateral
  const liqHealth = engine.getAccountHealth("0xliquidator");
  assert.equal(liqHealth.totalCollateralUsd, 4200n);

  // Borrower debt is reduced to $4,000
  const borrowerHealth = engine.getAccountHealth("0xborrower");
  assert.equal(borrowerHealth.totalDebtUsd, 4000n);
});
