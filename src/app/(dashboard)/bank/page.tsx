import { Landmark } from "lucide-react";
import type { Metadata } from "next";
import { SectionPlaceholder } from "@/platform/shell/SectionPlaceholder";

export const metadata: Metadata = { title: "Bank" };

export default function BankPage() {
  return (
    <SectionPlaceholder
      title="Bank"
      icon={<Landmark className="size-6" />}
      emptyTitle="House bank not available yet"
      description="Reserves, liabilities and exposure limits will be shown here once the house bank is specified."
    />
  );
}
