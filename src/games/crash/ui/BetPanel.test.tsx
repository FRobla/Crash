import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BetPanel } from "./BetPanel";

const REASON = "Betting unavailable — round engine not implemented.";

describe("BetPanel", () => {
  it("disables placing a bet and explains why", () => {
    render(<BetPanel assets={["SOL", "USDC"]} unavailableReason={REASON} />);

    const placeBet = screen.getByRole("button", { name: "Place bet" });
    expect(placeBet).toBeDisabled();
    expect(placeBet).toHaveAccessibleDescription(REASON);
  });

  it("disables every bet input", () => {
    render(<BetPanel assets={["SOL", "USDC"]} unavailableReason={REASON} />);

    expect(screen.getByLabelText("Amount")).toBeDisabled();
    expect(screen.getByLabelText("Auto cash-out (multiplier)")).toBeDisabled();
    expect(screen.getByRole("radio", { name: "SOL" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "USDC" })).toBeDisabled();
  });
});
