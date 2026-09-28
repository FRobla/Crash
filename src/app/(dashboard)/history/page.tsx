import { History } from "lucide-react";
import type { Metadata } from "next";
import { SectionPlaceholder } from "@/platform/shell/SectionPlaceholder";

export const metadata: Metadata = { title: "History" };

export default function HistoryPage() {
  return (
    <SectionPlaceholder
      title="History"
      icon={<History className="size-6" />}
      emptyTitle="No rounds yet"
      description="Settled rounds, bets and payouts will be listed here once the round engine and settlement exist."
    />
  );
}
