// Database passwords, kept so the console can show a connection string that
// actually works — the way every managed Postgres does.
//
// The trade is explicit: a password we can display is a password we can leak.
// So the ciphertext lives in D1 and the key lives in Worker secrets, which are
// stored separately. A copy of the database alone decrypts nothing.
//
// AES-256-GCM, a fresh 96-bit nonce per password, stored as nonce:ciphertext.

import { HttpError } from "./util";

const enc = new TextEncoder();
const dec = new TextDecoder();

const b64 = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b instanceof Uint8Array ? b.buffer as ArrayBuffer : b)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function keyFrom(secret: string | undefined): Promise<CryptoKey> {
  if (!secret) {
    throw new HttpError(
      501,
      "PASSWORD_KEY is not set, so stored passwords cannot be read; reset the password instead",
    );
  }
  // The secret is whatever string the operator set; hash it to exactly 256 bits.
  const material = await crypto.subtle.digest("SHA-256", enc.encode(secret));
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function sealPassword(secret: string | undefined, password: string): Promise<string | null> {
  if (!secret) return null; // no key configured: store nothing rather than something weak
  const key = await keyFrom(secret);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, enc.encode(password));
  return `${b64(nonce)}:${b64(sealed)}`;
}

export async function openPassword(secret: string | undefined, stored: string | null): Promise<string | null> {
  if (!stored) return null;
  const [nonce, body] = stored.split(":");
  if (!nonce || !body) return null;
  const key = await keyFrom(secret);
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(nonce) }, key, unb64(body));
    return dec.decode(plain);
  } catch {
    // Wrong key, or someone changed the ciphertext. Either way: do not guess.
    return null;
  }
}
