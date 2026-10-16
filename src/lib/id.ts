/**
 * `crypto.randomUUID()` only exists in a secure context (HTTPS or localhost).
 * Self-hosted AIFLUX served over plain HTTP — on a LAN IP, for example — has no
 * `randomUUID`, and calling it would white-screen the app on load. Fall back to
 * `getRandomValues` (also secure-context only) and then to Math.random.
 */
export function newId(): string {
  const webCrypto = typeof crypto === 'undefined' ? undefined : crypto;
  if (typeof webCrypto?.randomUUID === 'function') {
    try {
      return webCrypto.randomUUID();
    } catch {
      // Some browsers expose randomUUID but reject in unusual contexts.
    }
  }
  if (typeof webCrypto?.getRandomValues === 'function') {
    const bytes = webCrypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
