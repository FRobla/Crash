"use client";

import { StatusItem } from "@/platform/shell/StatusItem";
import { SOLANA_CLUSTER } from "../config";
import { RPC_HEALTH_VIEW } from "./rpc-health-view";
import { useRpcHealth } from "./RpcHealthProvider";

export function SolanaNetworkBadge() {
  const health = RPC_HEALTH_VIEW[useRpcHealth()];

  return (
    <div className="flex items-center gap-3 text-xs">
      <span
        className="border border-warn/50 px-1.5 py-0.5 font-semibold uppercase tracking-widest text-warn"
        title="Solana devnet: test network, tokens have no real value"
      >
        {SOLANA_CLUSTER}
      </span>
      <StatusItem label="rpc" value={health.label} tone={health.tone} />
    </div>
  );
}
