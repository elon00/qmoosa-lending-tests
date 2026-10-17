import { test } from "node:test";
import assert from "node:assert/strict";
import { LendingEngine } from "@qmoosa/lending-engine";
import { QmoosaLendingClient } from "@qmoosa/lending-sdk";

test("Negative Control 1: Zero amount transactions are strictly rejected", () => {
  const engine = new LendingEngine();
  engine.registerReserve({
    symbol: "USDC",
    decimals: 6,
    totalDepositedUsd: 1000n,
    totalBorrowedUsd: 0n,
    ltvBps: 8000,
    liquidationThresholdBps: 8500,
    liquidationBonusBps: 500,
    baseRateBps: 200,
    optimalUtilizationBps: 8000,
    rateSlope1Bps: 400,
    rateSlope2Bps: 6000
  });

  assert.throws(() => engine.deposit("user1", "USDC", 0n), /Deposit amount must be strictly positive/);
  assert.throws(() => engine.borrow("user1", "USDC", 0n), /Borrow amount must be strictly positive/);
  assert.throws(() => engine.repay("user1", "USDC", 0n), /Repay amount must be strictly positive/);
  assert.throws(() => engine.withdraw("user1", "USDC", 0n), /Withdraw amount must be strictly positive/);
});

test("Negative Control 2: Unregistered asset operations fail closed", () => {
  const engine = new LendingEngine();
  assert.throws(() => engine.deposit("user1", "UNKNOWN", 100n), /Reserve UNKNOWN not found/);
});

test("Negative Control 3: Self-liquidation is strictly prohibited across SDK and Engine", () => {
  const client = new QmoosaLendingClient();
  assert.throws(
    () => client.buildLiquidationPayload("0xalice", "0xalice", "USDC", 1000n, "WETH"),
    /Self-liquidation strictly prohibited/
  );

  const engine = new LendingEngine();
  assert.throws(
    () => engine.liquidate("0xalice", "0xalice", "USDC", 1000n, "WETH"),
    /Self-liquidation strictly forbidden/
  );
});

test("Negative Control 4: Unconfigured SDK adapter fails closed with zero manufactured receipts", async () => {
  const client = new QmoosaLendingClient();
  const payload = client.buildDepositPayload("0x1111", "USDC", 1000n);

  await assert.rejects(
    () => client.broadcast(payload),
    /Chain adapter not configured/
  );
});
