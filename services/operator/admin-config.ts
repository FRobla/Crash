import { readFileSync } from "node:fs";
import { Connection, Keypair } from "@solana/web3.js";
import { decodeHouseConfig } from "@/chain-adapters/solana/crash-program/accounts";
import { CRASH_PROGRAM_ID } from "@/chain-adapters/solana/crash-program/deployment";
import { updateConfigIx } from "@/chain-adapters/solana/crash-program/instructions";
import { houseConfigAddress } from "@/chain-adapters/solana/crash-program/pdas";
import { DEVNET_GENESIS_HASH } from "@/chain-adapters/solana/config";
import { OperatorChain } from "./chain";
import { parseOperatorConfig } from "./config";
import { bettingSlotsFor, parseBettingSeconds, updatedConfigArgs } from "./admin-config-math";
import { createLogger } from "./logger";

/**
 * Admin tool (spec crash-client-v1 §4.6): `pnpm operator:config -- --betting-seconds 15` sets the
 * house's betting window from seconds, converted to slots with the cluster's measured slot
 * duration. Only `betting_slots` changes; every other field is copied from the account it read.
 */

const log = createLogger();

async function main(): Promise<void> {
  const seconds = parseBettingSeconds(process.argv.slice(2));
  const env = parseOperatorConfig(process.env, process.cwd());
  const bytes: unknown = JSON.parse(readFileSync(env.keypairPath, "utf8"));
  if (!Array.isArray(bytes) || bytes.length !== 64) throw new Error("keypair file is not a 64-byte array");
  const admin = Keypair.fromSecretKey(Uint8Array.from(bytes as number[]));

  const connection = new Connection(env.rpcUrl, { commitment: "confirmed" });
  if ((await connection.getGenesisHash()) !== DEVNET_GENESIS_HASH) throw new Error("RPC is not Solana devnet");
  const chain = new OperatorChain(connection, admin, CRASH_PROGRAM_ID, env.priorityFeeMicroLamports);

  const read = async () => {
    const info = await connection.getAccountInfo(houseConfigAddress(CRASH_PROGRAM_ID), "confirmed");
    if (!info) throw new Error("house config not found");
    return decodeHouseConfig(info, CRASH_PROGRAM_ID);
  };
  const before = await read();
  if (!before.admin.equals(admin.publicKey)) throw new Error("keypair is not the house admin");

  const msPerSlot = await chain.measuredMsPerSlot();
  if (msPerSlot === null) throw new Error("could not measure the slot duration");
  const bettingSlots = bettingSlotsFor(seconds, msPerSlot);
  const args = updatedConfigArgs(before, bettingSlots);
  log.info("update-config", {
    bettingSeconds: seconds,
    msPerSlot: Math.round(msPerSlot),
    bettingSlots: String(bettingSlots),
    previousBettingSlots: String(before.timeouts.bettingSlots),
  });

  const result = await chain.send([updateConfigIx(CRASH_PROGRAM_ID, admin.publicKey, args)]);
  if (!result.ok) throw new Error(`update_config failed: ${result.programError ?? result.error}`);

  const after = await read();
  const expected = args;
  const same =
    after.operator.equals(expected.operator) &&
    JSON.stringify(after.limits, bigintJson) === JSON.stringify(expected.limits, bigintJson) &&
    JSON.stringify(after.timeouts, bigintJson) === JSON.stringify(expected.timeouts, bigintJson) &&
    JSON.stringify(after.playerPolicy, bigintJson) === JSON.stringify(expected.playerPolicy, bigintJson) &&
    after.maxBetsPerRound === expected.maxBetsPerRound &&
    after.paused === expected.paused;
  log[same ? "info" : "error"]("update-config-verified", {
    signature: result.signature,
    bettingSlots: String(after.timeouts.bettingSlots),
    matches: same,
  });
  if (!same) process.exitCode = 1;
}

function bigintJson(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

main().catch((error) => {
  log.error("fatal", { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
