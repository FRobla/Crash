import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PlayerAccountProvider, type PlayerAccountPort } from "./player-account";
import { PlayerPanel } from "./PlayerPanel";

function account(overrides: Partial<PlayerAccountPort> = {}): PlayerAccountPort {
  return {
    wallet: "connected",
    status: "unregistered",
    username: null,
    address: "DUfBEagYErLiFnBk16QjR94pJJ3zPe1eQnTRHtfZQwZ4",
    balance: null,
    walletBalance: 1_000_000_000n,
    session: { status: "none", spendCap: 0n, spent: 0n, expiresInSeconds: null },
    hasActiveBet: false,
    registrationOverhead: 13_438_240n,
    action: { status: "idle" },
    explorerUrl: (signature) => `https://explorer.example/${signature}`,
    checkUsername: vi.fn(async () => "available" as const),
    register: vi.fn(async () => undefined),
    buy: vi.fn(async () => undefined),
    renewSession: vi.fn(async () => undefined),
    revokeSession: vi.fn(async () => undefined),
    exit: vi.fn(async () => undefined),
    ...overrides,
  };
}

function renderPanel(port: PlayerAccountPort) {
  return render(
    <PlayerAccountProvider value={port}>
      <PlayerPanel />
    </PlayerAccountProvider>,
  );
}

describe("PlayerPanel", () => {
  it("asks for a wallet first", () => {
    renderPanel(account({ wallet: "disconnected", address: null }));
    expect(screen.getByText(/Connect a devnet wallet/)).toBeInTheDocument();
  });

  it("registers with a lowercase name and the coins in base units", async () => {
    const port = account();
    renderPanel(port);
    await userEvent.type(screen.getByLabelText(/Username/), "Alice_1");
    await userEvent.clear(screen.getByLabelText(/Coins to buy/));
    await userEvent.type(screen.getByLabelText(/Coins to buy/), "2.5");
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(port.checkUsername).toHaveBeenCalledWith("alice_1");
    expect(port.register).toHaveBeenCalledWith("alice_1", 2_500_000n);
  });

  it("refuses invalid or taken names before asking for a signature", async () => {
    const port = account({ checkUsername: vi.fn(async () => "taken" as const) });
    renderPanel(port);
    await userEvent.type(screen.getByLabelText(/Username/), "ab");
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/3–16 characters/);
    await userEvent.type(screen.getByLabelText(/Username/), "c");
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/taken/);
    expect(port.register).not.toHaveBeenCalled();
  });

  it("shows the balance and session, and blocks exit while a bet is open", () => {
    renderPanel(
      account({
        status: "registered",
        username: "alice",
        balance: 3_280_000n,
        session: { status: "active", spendCap: 5_000_000n, spent: 1_000_000n, expiresInSeconds: 7_200 },
        hasActiveBet: true,
      }),
    );
    expect(screen.getByText("3.28 coins")).toBeInTheDocument();
    expect(screen.getByText(/1.00 \/ 5.00 coins/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Sell all/ })).toBeDisabled();
  });

  it("offers a new session when this device has none", async () => {
    const port = account({
      status: "registered",
      username: "alice",
      balance: 1_000_000n,
      session: { status: "other-device", spendCap: 1n, spent: 0n, expiresInSeconds: 100 },
    });
    renderPanel(port);
    await userEvent.click(screen.getByRole("button", { name: "Open betting session" }));
    expect(port.renewSession).toHaveBeenCalled();
  });

  it("reports a rejected action with its reason", () => {
    renderPanel(account({ action: { status: "rejected", label: "Create account", reason: "cancelled in the wallet" } }));
    expect(screen.getByRole("status")).toHaveTextContent("Create account: rejected — cancelled in the wallet");
  });
});
