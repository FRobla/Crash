import { PublicKey } from "@solana/web3.js";

/**
 * The crash program v2 deployed on devnet (docs/specs/crash-program-v2.md §15). Pinned in code, like
 * the cluster: pointing the app at another program is a deliberate, reviewed change.
 */
export const CRASH_PROGRAM_ID = new PublicKey("DNmfJzhj6Uaa1Zbd2HhUT9mES27jhzXkMThDm3ikRarM");
