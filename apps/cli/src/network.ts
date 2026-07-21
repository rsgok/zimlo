import { networkInterfaces } from "node:os";

export function isLoopbackAddress(input: string): boolean {
  const address = normalize(input);
  return address === "::1" || address.startsWith("127.");
}

export function isTrustedLanAddress(input: string): boolean {
  const address = normalize(input).toLowerCase();
  if (isLoopbackAddress(address)) return true;
  const octets = address.split(".").map(Number);
  if (octets.length === 4 && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    return octets[0] === 10
      || (octets[0] === 172 && (octets[1] ?? 0) >= 16 && (octets[1] ?? 0) <= 31)
      || (octets[0] === 192 && octets[1] === 168);
  }
  return address.startsWith("fc") || address.startsWith("fd");
}

export function preferredLanAddress(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal && isTrustedLanAddress(address.address)) {
        return address.address;
      }
    }
  }
  return null;
}

function normalize(input: string): string {
  const withoutZone = input.split("%")[0] ?? input;
  return withoutZone.startsWith("::ffff:") ? withoutZone.slice(7) : withoutZone;
}
