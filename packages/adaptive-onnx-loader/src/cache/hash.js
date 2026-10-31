/** SHA-256 of bytes as lowercase hex, via WebCrypto (browser main thread, Workers and Node ≥ 19). */
export async function sha256Hex(bytes) {
  const d = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  let s = ''; for (const b of d) s += b.toString(16).padStart(2, '0');
  return s;
}
