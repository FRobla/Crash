import type { Metadata } from "next";
import { FairnessView } from "./fairness-view";

export const metadata: Metadata = { title: "Fairness" };

export default async function FairnessPage(props: PageProps<"/fairness">) {
  const { round } = await props.searchParams;
  const requested = typeof round === "string" && /^\d{1,19}$/.test(round) ? round : null;
  return <FairnessView requestedRound={requested} />;
}
