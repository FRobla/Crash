// @vitest-environment node
// web3.js PDA derivation fails under jsdom (typed-array realm mismatch); browsers and Node are fine.
import { Buffer } from "buffer";
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  PLAYER_ACTIVE_BET_ROUND_ID_OFFSET,
  PLAYER_ACTIVE_BET_TAG_OFFSET,
  decodeHouseConfig,
  decodeHouseVault,
  decodePlayer,
  decodeRound,
} from "./accounts";
import { BorshWriter, encodeType } from "./borsh";
import { CRASH_PROGRAM_ID } from "./deployment";
import { describeProgramError, programErrorName } from "./errors";
import { betSettledEvents, decodeEvents } from "./events";
import { CRASH_IDL, CRASH_IDL_PROGRAM_ID, CRASH_IDL_TYPES, definedType, idlAccountDiscriminator } from "./idl";
import { buildInstruction, cashOutIx, placeBetIx, registerPlayerIx, revealIx, settleBetIx } from "./instructions";
import { houseConfigAddress, playerAddress, roundAddress } from "./pdas";
import accounts from "./fixtures/devnet-accounts.json";
import transactions from "./fixtures/round-3-transactions.json";

const PID = CRASH_PROGRAM_ID;
const OPERATOR = new PublicKey("3R48JPhp8zkRokLdGJx8rFDT53CiKz92BYJErkipzpqV");

function fixture(account: { owner: string; data: string }) {
  return { owner: new PublicKey(account.owner), data: Uint8Array.from(Buffer.from(account.data, "base64")) };
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function le64(value: bigint): string {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value);
  return out.toString("hex");
}

describe("IDL", () => {
  it("belongs to the pinned devnet program", () => {
    expect(CRASH_IDL_PROGRAM_ID.equals(PID)).toBe(true);
  });

  it("derives the deployed account addresses", () => {
    expect(houseConfigAddress(PID).toBase58()).toBe(accounts.houseConfig.address);
    expect(roundAddress(PID, 3n).toBase58()).toBe(accounts.rounds[3].address);
  });
});

describe("instructions", () => {
  const owner = Keypair.generate().publicKey;
  const session = Keypair.generate().publicKey;

  it("follows the IDL account order, flags and discriminator", () => {
    const built = {
      place_bet: placeBetIx(PID, owner, session, { roundId: 3n, stake: 1n, autoCashOut: 0n }),
      cash_out: cashOutIx(PID, owner, session, 3n),
      settle_bet: settleBetIx(PID, owner, 3n),
      register_player: registerPlayerIx(PID, owner, "alice_1"),
      reveal: revealIx(PID, 3n, new Uint8Array(32)),
    };
    for (const [name, ix] of Object.entries(built)) {
      const spec = CRASH_IDL.instructions.find((candidate) => candidate.name === name)!;
      expect(ix.programId.equals(PID)).toBe(true);
      expect(ix.keys.map((key) => [key.isSigner, key.isWritable])).toEqual(
        spec.accounts.map((account) => [account.signer === true, account.writable === true]),
      );
      expect([...ix.data.subarray(0, 8)]).toEqual(spec.discriminator);
    }
  });

  it("encodes place_bet arguments as little-endian u64s", () => {
    const ix = placeBetIx(PID, owner, session, { roundId: 3n, stake: 1_000_000n, autoCashOut: 20_000n });
    expect(hex(ix.data.subarray(8))).toBe(le64(3n) + le64(1_000_000n) + le64(20_000n));
    expect(ix.keys[0].pubkey.equals(session)).toBe(true);
    expect(ix.keys[3].pubkey.equals(roundAddress(PID, 3n))).toBe(true);
    expect(ix.keys[4].pubkey.equals(playerAddress(PID, owner))).toBe(true);
  });

  it("encodes strings with a u32 length prefix", () => {
    const ix = registerPlayerIx(PID, owner, "bob");
    expect(hex(ix.data.subarray(8))).toBe("03000000" + hex(new TextEncoder().encode("bob")));
  });

  it("rejects missing, extra and out-of-range arguments", () => {
    const sell = { owner, player: owner };
    expect(() => buildInstruction(PID, "buy_coins", { owner }, {})).toThrow(/missing/);
    expect(() => buildInstruction(PID, "sell_coins", sell, { amount: 1n, extra: 1 })).toThrow(/unexpected/);
    expect(() => buildInstruction(PID, "sell_coins", sell, { amount: -1n })).toThrow(/u64/);
    expect(() => buildInstruction(PID, "sell_coins", sell, { amount: 1n << 64n })).toThrow(/u64/);
    expect(() => buildInstruction(PID, "sell_coins", sell, { amount: 1 })).toThrow(/u64/);
    expect(() => revealIx(PID, 1n, new Uint8Array(31))).toThrow(/32 bytes/);
  });
});

describe("account decoders", () => {
  it("decodes the deployed house config", () => {
    const config = decodeHouseConfig(fixture(accounts.houseConfig), PID);
    expect(config.operator.equals(OPERATOR)).toBe(true);
    expect(config.admin.equals(OPERATOR)).toBe(true);
    expect(config.rulesVersion).toBe(1);
    expect(config.limits).toEqual({
      minStake: 1_000_000n,
      maxStake: 2_000_000n,
      maxPayout: 200_000_000n,
      maxRoundExposure: 500_000_000n,
    });
    expect(config.timeouts).toEqual({ bettingSlots: 50n, entropyTimeoutSlots: 300n, revealGraceSlots: 150n });
    expect(config.randomnessAccount.toBase58()).toBe("3gNTQo8XRg1HomKXtpkq6GWr5jHvcxkG4xV15bzMkjTR");
    expect(config.nextRoundId).toBe(11n);
    expect(config.currentRound).toBeNull();
  });

  it("decodes the vault and revealed and voided rounds", () => {
    expect(decodeHouseVault(fixture(accounts.houseVault), PID).reservedExposure).toBe(0n);
    const round = decodeRound(fixture(accounts.rounds[3]), PID);
    expect(round).toMatchObject({ roundId: 3n, phase: "Settled", crashPoint: 94_500n, crashTick: 95n, betCount: 2 });
    expect(hex(round.commit)).toBe("42a916d2f72741b47b75d3d181df62f48630f3ff0d03fa0b47cb0e25aceaf47a");
    expect(decodeRound(fixture(accounts.rounds[1]), PID).phase).toBe("Voided");
  });

  it("rejects a foreign owner, a wrong discriminator and truncated data", () => {
    const config = fixture(accounts.houseConfig);
    expect(() => decodeHouseConfig({ ...config, owner: OPERATOR }, PID)).toThrow(/not owned/);
    expect(() => decodeRound(config, PID)).toThrow(/discriminator/);
    expect(() => decodeHouseConfig({ ...config, data: config.data.subarray(0, 60) }, PID)).toThrow(/end of data/);
  });

  it("round-trips a Player with an active bet and matches the filter offsets", () => {
    const owner = Keypair.generate().publicKey;
    const writer = new BorshWriter();
    writer.bytes(idlAccountDiscriminator("Player"));
    const name = new Uint8Array(16);
    name.set(new TextEncoder().encode("carol"));
    encodeType(
      writer,
      definedType("Player"),
      {
        owner,
        username: { len: 5, bytes: name },
        usernameChangedSlot: 10n,
        balance: 5_000_000n,
        activeBet: { roundId: 0x0102030405n, stake: 1_000_000n, autoCashOut: 0n, exposure: 2n, cashOutTick: 7n },
        session: null,
        totalWagered: 9n,
        betsSettled: 1n,
        createdSlot: 10n,
        bump: 255,
      },
      CRASH_IDL_TYPES,
    );
    const data = writer.toBytes();
    expect(data[PLAYER_ACTIVE_BET_TAG_OFFSET]).toBe(1);
    expect(hex(data.subarray(PLAYER_ACTIVE_BET_ROUND_ID_OFFSET, PLAYER_ACTIVE_BET_ROUND_ID_OFFSET + 8))).toBe(
      le64(0x0102030405n),
    );
    const player = decodePlayer({ owner: PID, data }, PID);
    expect(player.username).toBe("carol");
    expect(player.owner.equals(owner)).toBe(true);
    expect(player.activeBet).toEqual({
      roundId: 0x0102030405n,
      stake: 1_000_000n,
      autoCashOut: 0n,
      exposure: 2n,
      cashOutTick: 7n,
    });
    expect(player.session).toBeNull();
  });
});

describe("events", () => {
  it("decodes the settlements of a real round", () => {
    const settled = transactions.flatMap((tx) => betSettledEvents(tx.logs, PID)).filter((e) => e.roundId === 3n);
    expect(settled).toHaveLength(2);
    expect(settled[0]).toMatchObject({
      stake: 2_000_000n,
      cashOutTick: 21n,
      outcome: "CashedOut",
      multiplier: 16_400n,
      payout: 3_280_000n,
    });
    expect(settled[1]).toMatchObject({ autoCashOut: 20_000n, cashOutTick: null, payout: 2_000_000n });
  });

  it("ignores data logged by another program, even inside a crash instruction", () => {
    const real = transactions.find((tx) => tx.logs.some((line) => line.includes("Instruction: Reveal")))!;
    const dataLine = real.logs.find((line) => line.startsWith("Program data: "))!;
    const other = "Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2";
    const forged = [
      `Program ${PID.toBase58()} invoke [1]`,
      `Program ${other} invoke [2]`,
      dataLine,
      `Program ${other} success`,
      `Program ${PID.toBase58()} success`,
    ];
    expect(decodeEvents(forged, PID)).toEqual([]);
    expect(decodeEvents(real.logs, PID).map((event) => event.name)).toEqual(["RoundRevealed"]);
  });
});

describe("errors", () => {
  it("names program and Anchor errors", () => {
    expect(programErrorName(6006)).toBe("BettingClosed");
    expect(programErrorName(2006)).toBe("ConstraintSeeds");
    expect(describeProgramError(new Error("failed: custom program error: 0x1776"))).toBe("BettingClosed");
    const logs = ["Program log: AnchorError occurred. Error Code: SessionExpired. Error Number: 6037."];
    expect(describeProgramError(null, logs)).toBe("SessionExpired");
    expect(describeProgramError(new Error("Blockhash not found"))).toBeNull();
  });
});
