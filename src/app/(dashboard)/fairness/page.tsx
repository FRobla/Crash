import { ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import { SectionPlaceholder } from "@/platform/shell/SectionPlaceholder";

export const metadata: Metadata = { title: "Fairness" };

export default function FairnessPage() {
  return (
    <SectionPlaceholder
      title="Fairness"
      icon={<ShieldCheck className="size-6" />}
      emptyTitle="Verifier not available yet"
      description="The provably fair scheme is not specified yet. Round commitments, proofs and an independent verifier will live here."
    />
  );
}
