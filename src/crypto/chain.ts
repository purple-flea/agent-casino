import { ethers } from "ethers";

// ─── Constants ───

export const BASE_RPC = "https://mainnet.base.org";
export const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const TREASURY_ADDRESS = "0x632881b5f5384e872d8b701dd23f08e63a52faee";
export const USDC_DECIMALS = 6;

// Minimal ERC-20 ABI for balanceOf + transfer
const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
];

// ─── Provider ───

let _provider: ethers.JsonRpcProvider | null = null;

export function getProvider(): ethers.JsonRpcProvider {
  if (!_provider) {
    _provider = new ethers.JsonRpcProvider(BASE_RPC);
  }
  return _provider;
}

// ─── USDC Contract (read-only) ───

export function getUsdcContract(): ethers.Contract {
  return new ethers.Contract(USDC_ADDRESS, ERC20_ABI, getProvider());
}

// ─── USDC Contract (with signer, for treasury sends) ───

export function getTreasurySigner(): ethers.Wallet {
  const pk = process.env.TREASURY_PRIVATE_KEY;
  if (!pk) {
    throw new Error("TREASURY_PRIVATE_KEY env var not set");
  }
  return new ethers.Wallet(pk, getProvider());
}

export function getUsdcWithSigner(): ethers.Contract {
  return new ethers.Contract(USDC_ADDRESS, ERC20_ABI, getTreasurySigner());
}

// ─── Read USDC balance for an address (returns USD amount as number) ───

export async function getUsdcBalance(address: string): Promise<number> {
  const usdc = getUsdcContract();
  const raw: bigint = await usdc.balanceOf(address);
  return Number(raw) / 10 ** USDC_DECIMALS;
}

// ─── Send USDC from treasury to a destination address ───

export async function sendUsdc(
  toAddress: string,
  amountUsd: number
): Promise<{ txHash: string; amount: number }> {
  const usdc = getUsdcWithSigner();
  const rawAmount = BigInt(Math.floor(amountUsd * 10 ** USDC_DECIMALS));

  const tx = await usdc.transfer(toAddress, rawAmount);
  const receipt = await tx.wait();

  return {
    txHash: receipt.hash,
    amount: amountUsd,
  };
}

// ─── Sweep USDC from a deposit address to treasury ───
// Requires the deposit address private key (from wallet service)

export async function sweepToTreasury(
  fromPrivateKey: string,
  depositAddress: string
): Promise<{ txHash: string; amount: number } | null> {
  const balance = await getUsdcBalance(depositAddress);
  if (balance < 0.01) return null; // dust threshold

  const signer = new ethers.Wallet(fromPrivateKey, getProvider());
  const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, signer);
  const rawBalance: bigint = await usdc.balanceOf(depositAddress);

  const tx = await usdc.transfer(TREASURY_ADDRESS, rawBalance);
  const receipt = await tx.wait();

  return {
    txHash: receipt.hash,
    amount: balance,
  };
}
