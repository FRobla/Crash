"use client";

import { useConnection } from "@solana/wallet-adapter-react";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { classifyGenesisHash, classifyRpcError, RPC_HEALTH_CHECK_INTERVAL_MS, type RpcHealth } from "./rpc-health";

const RpcHealthContext = createContext<RpcHealth>("checking");

/** Periodically checks that the RPC endpoint answers and serves devnet. */
export function RpcHealthProvider({ children }: { children: ReactNode }) {
  const { connection } = useConnection();
  const [health, setHealth] = useState<RpcHealth>("checking");

  useEffect(() => {
    let cancelled = false;

    async function check() {
      try {
        const genesisHash = await connection.getGenesisHash();
        if (!cancelled) setHealth(classifyGenesisHash(genesisHash));
      } catch (error) {
        if (!cancelled) setHealth(classifyRpcError(error));
      }
    }

    void check();
    const intervalId = setInterval(() => void check(), RPC_HEALTH_CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [connection]);

  return <RpcHealthContext.Provider value={health}>{children}</RpcHealthContext.Provider>;
}

export function useRpcHealth(): RpcHealth {
  return useContext(RpcHealthContext);
}
