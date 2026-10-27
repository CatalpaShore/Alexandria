type ClientCrypto = Pick<Crypto, "getRandomValues"> & Partial<Pick<Crypto, "randomUUID">>;

function randomBytes(cryptoApi: ClientCrypto | null): Uint8Array {
  const bytes = new Uint8Array(16);
  if (cryptoApi?.getRandomValues) {
    cryptoApi.getRandomValues(bytes);
    return bytes;
  }

  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

/**
 * Generates a request-safe UUID in LAN Android WebViews too. `crypto.randomUUID`
 * is unavailable in some non-secure HTTP contexts even though `getRandomValues`
 * is supported, so Agent sending must not depend on it directly.
 */
export function createClientUuid(
  cryptoApi: ClientCrypto | null = globalThis.crypto ?? null
): string {
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();

  const bytes = randomBytes(cryptoApi);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}
