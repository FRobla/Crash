import type { StatusTone } from "@/platform/shell/status-tone";
import type { RpcHealth } from "./rpc-health";

export const RPC_HEALTH_VIEW: Record<RpcHealth, { label: string; tone: StatusTone }> = {
  checking: { label: "checking", tone: "warn" },
  ok: { label: "ok", tone: "ok" },
  "wrong-network": { label: "wrong network", tone: "danger" },
  "rate-limited": { label: "rate-limited", tone: "warn" },
  unreachable: { label: "unreachable", tone: "danger" },
};
