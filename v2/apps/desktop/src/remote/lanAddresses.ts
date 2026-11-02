import type { NetworkInterfaceInfo } from "node:os";

/**
 * IPv4 addresses a phone on the same network can reach. Loopback, link-local, and the address ranges
 * that container and VM bridges use are left out, so the QR code lists real Wi-Fi or Ethernet first.
 */
export function lanAddresses(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string[] {
  const found: { address: string; rank: number }[] = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (entry.address.startsWith("169.254.")) continue;
      found.push({ address: entry.address, rank: rank(name, entry.address) });
    }
  }
  return [...new Set(found.sort((left, right) => left.rank - right.rank).map((entry) => entry.address))].slice(0, 6);
}

function rank(name: string, address: string): number {
  const virtual = /^(docker|br-|veth|virbr|vmnet|vboxnet|utun|tun|tap|zt|tailscale|wg)/iu.test(name);
  if (virtual) return 3;
  if (address.startsWith("192.168.") || address.startsWith("10.")) return 0;
  if (/^172\.(1[6-9]|2\d|3[01])\./u.test(address)) return 1;
  return 2;
}
