import { History, Users } from "lucide-react";
import { EmptyState } from "@/platform/shell/EmptyState";
import { Panel } from "@/platform/shell/Panel";

export function RoundFeed() {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Panel titleId="recent-rounds-title" title="Recent rounds">
        <EmptyState
          icon={<History className="size-5" />}
          title="No rounds yet"
          description="Settled rounds will appear here with their crash point and fairness proof."
        />
      </Panel>
      <Panel titleId="live-bets-title" title="Live bets">
        <EmptyState
          icon={<Users className="size-5" />}
          title="No bets in this round"
          description="Accepted bets and cash-outs will appear here with their confirmation state."
        />
      </Panel>
    </div>
  );
}
