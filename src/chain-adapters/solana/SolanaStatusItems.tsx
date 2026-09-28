"use client";

import { StatusItem } from "@/platform/shell/StatusItem";
import { shortenAddress } from "@/platform/wallets/wallet-session";
import { solanaConfig } from "./config";
import { RPC_HEALTH_VIEW } from "./network/rpc-health-view";
import { useRpcHealth } from "./network/RpcHealthProvider";
import { useSolanaWalletSession } from "./wallet/use-solana-wallet-session";

export function SolanaStatusItems() {
  const health = RPC_HEALTH_VIEW[useRpcHealth()];
  const session = useSolanaWalletSession();

  return (
    <>
      <StatusItem label="chain" value={`solana/${solanaConfig.cluster}`} />
      <StatusItem label="rpc" value={`${solanaConfig.rpcHost} ${health.label}`} tone={health.tone} />
      <StatusItem
        label="wallet"
        value={session.address ? shortenAddress(session.address) : session.status}
        tone={session.status === "connected" ? "ok" : "neutral"}
      />
    </>
  );
}
