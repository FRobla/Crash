import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const walletProviderProps = vi.hoisted(() => [] as Record<string, unknown>[]);
const setVisible = vi.hoisted(() => vi.fn());

vi.mock("@solana/wallet-adapter-react", () => ({
  ConnectionProvider: ({ children }: { children: ReactNode }) => children,
  WalletProvider: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => {
    walletProviderProps.push(props);
    return children;
  },
  useWallet: () => ({ publicKey: null, connected: false, connecting: false, disconnecting: false, wallet: null, disconnect: vi.fn() }),
}));
vi.mock("@solana/wallet-adapter-react-ui", () => ({
  WalletModalProvider: ({ children }: { children: ReactNode }) => children,
  useWalletModal: () => ({ setVisible }),
}));
vi.mock("@solana/wallet-adapter-react-ui/styles.css", () => ({}));
vi.mock("../network/RpcHealthProvider", () => ({ RpcHealthProvider: ({ children }: { children: ReactNode }) => children }));

const { SolanaWalletProvider } = await import("./SolanaWalletProvider");
const { SolanaWalletControl } = await import("./SolanaWalletControl");
const { clearWalletError, describeWalletError, reportWalletError } = await import("./wallet-errors");

afterEach(() => {
  act(() => clearWalletError());
  walletProviderProps.length = 0;
});

describe("wallet connection", () => {
  it("connects as soon as a wallet is picked (the modal only selects it) and reports adapter errors", () => {
    render(
      <SolanaWalletProvider>
        <span>app</span>
      </SolanaWalletProvider>,
    );
    expect(walletProviderProps[0]).toMatchObject({ autoConnect: true, onError: reportWalletError });
  });

  it("shows adapter errors next to the connect button until dismissed or retried", async () => {
    render(<SolanaWalletControl />);
    const notReady = new Error("not ready");
    notReady.name = "WalletNotReadyError";
    act(() => reportWalletError(notReady));
    expect(screen.getByRole("alert")).toHaveTextContent(/not installed/);
    await userEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
    expect(setVisible).toHaveBeenCalledWith(true);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("describes rejections and unknown errors without dumping stacks", () => {
    expect(describeWalletError(new Error("User rejected the request."))).toMatch(/cancelled/);
    expect(describeWalletError(new Error("boom\nstack"))).toBe("Wallet error: boom");
  });
});
