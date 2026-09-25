/// Turns the text in a scanned QR into a lowercase wallet address, or null.
/// Accepts a bare address (what the Takarabako email shows) and the EIP-681
/// form wallet apps use for "receive" codes: ethereum:0x…[@chainId][?…].
export function parseWalletFromQr(text: string): string | null {
  let s = text.trim();
  if (s.toLowerCase().startsWith("ethereum:")) s = s.slice("ethereum:".length);
  s = s.split(/[@?/]/)[0];
  return /^0x[0-9a-fA-F]{40}$/.test(s) ? s.toLowerCase() : null;
}
