/**
 * XMR (Monero) key derivation for casino deposit addresses.
 *
 * Keys are derived deterministically from the casino's TREASURY_PRIVATE_KEY + agentId.
 * The same agentId always produces the same Monero address and keys — no storage needed.
 *
 * Algorithm:
 *   1. HMAC-SHA512(key=masterKey, data=agentId+":xmr-deposit") → 64-byte seed
 *   2. scReduce32(seed[0:32]) → private spend key
 *   3. scReduce32(keccak256(spend_key)) → private view key
 *   4. Ed25519 scalar multiplication → public keys
 *   5. Monero mainnet address = moneroBase58(0x12 || pubSpend || pubView || checksum)
 *
 * IMPORTANT: uses @noble/curves v1.x API (ExtendedPoint + toRawBytes).
 * This package is a transitive dependency of ethers.
 */

// @ts-ignore — transitive dep from ethers (@noble/curves v1.x)
import { ed25519 } from "@noble/curves/ed25519";
import { keccak_256 } from "@noble/hashes/sha3";
import { hmac } from "@noble/hashes/hmac";
import { sha512 } from "@noble/hashes/sha512";

// Ed25519 curve order (l)
const CURVE_ORDER = 7237005577332262213973186563042994240857116359379907606001950938285454250989n;

// Monero block-based base58 constants
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ENCODED_BLOCK_SIZES = [0, 2, 3, 5, 6, 7, 9, 10, 11];
const FULL_BLOCK_SIZE = 8;

function scReduce32(buf: Uint8Array): Uint8Array {
  let n = 0n;
  for (let i = 0; i < 32; i++) n += BigInt(buf[i]) << BigInt(i * 8);
  n = n % CURVE_ORDER;
  const result = new Uint8Array(32);
  let tmp = n;
  for (let i = 0; i < 32; i++) { result[i] = Number(tmp & 0xffn); tmp >>= 8n; }
  return result;
}

function scalarToPublicKey(scalar32: Uint8Array): Uint8Array {
  let s = 0n;
  for (let i = 0; i < 32; i++) s += BigInt(scalar32[i]) << BigInt(i * 8);
  // v1.x: ExtendedPoint; v2.x: Point — handle both
  const EP = (ed25519.ExtendedPoint ?? (ed25519 as any).Point) as any;
  const pt = EP.BASE.multiply(s);
  return pt.toRawBytes ? pt.toRawBytes() : pt.toBytes();
}

function encodeBlock(block: Uint8Array, size: number, out: string[]): void {
  let n = 0n;
  for (const b of block) n = n * 256n + BigInt(b);
  const chars = new Array<string>(size).fill(ALPHABET[0]);
  for (let j = size - 1; j >= 0; j--) { chars[j] = ALPHABET[Number(n % 58n)]; n /= 58n; }
  out.push(...chars);
}

function moneroBase58(data: Uint8Array): string {
  const out: string[] = [];
  const full = Math.floor(data.length / FULL_BLOCK_SIZE);
  for (let i = 0; i < full; i++)
    encodeBlock(data.slice(i * FULL_BLOCK_SIZE, (i + 1) * FULL_BLOCK_SIZE), ENCODED_BLOCK_SIZES[FULL_BLOCK_SIZE], out);
  const rem = data.length % FULL_BLOCK_SIZE;
  if (rem) encodeBlock(data.slice(full * FULL_BLOCK_SIZE), ENCODED_BLOCK_SIZES[rem], out);
  return out.join("");
}

export interface XmrKeys {
  privateSpendKey: string;  // 32 bytes hex
  privateViewKey: string;   // 32 bytes hex
  address: string;          // Monero mainnet primary address (starts with "4")
}

/**
 * Derive deterministic Monero deposit keys for a casino agent.
 * @param agentId   — casino agent ID (unique per agent)
 * @param masterKey — casino TREASURY_PRIVATE_KEY (hex with or without 0x prefix)
 */
export function deriveXmrDepositKeys(agentId: string, masterKey: string): XmrKeys {
  const master = Buffer.from(masterKey.replace("0x", ""), "hex");
  const seed = hmac(sha512, master, Buffer.from(`${agentId}:xmr-deposit`));

  const spendKey = scReduce32(seed.slice(0, 32));
  const viewKey = scReduce32(keccak_256(spendKey));
  const pubSpend = scalarToPublicKey(spendKey);
  const pubView = scalarToPublicKey(viewKey);

  // Monero mainnet standard address: 0x12 + pub_spend(32) + pub_view(32) + checksum(4)
  const payload = new Uint8Array(65);
  payload[0] = 0x12;
  payload.set(pubSpend, 1);
  payload.set(pubView, 33);
  const checksum = keccak_256(payload).slice(0, 4);

  const full = new Uint8Array(69);
  full.set(payload);
  full.set(checksum, 65);

  return {
    privateSpendKey: Buffer.from(spendKey).toString("hex"),
    privateViewKey: Buffer.from(viewKey).toString("hex"),
    address: moneroBase58(full),
  };
}
