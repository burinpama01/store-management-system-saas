import net from "net";

const PRIVATE_LAN_RANGES = [
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
];

const BLOCKED_LAN_RANGES = [
  /^127\./,
  /^169\.254\./,
  /^0\./,
  /^255\./,
];

export function isAllowedNetworkPrinterHost(ip: string): boolean {
  if (net.isIPv6(ip)) return false;
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) return false;

  const octets = ip.split(".").map(Number);
  if (octets.some((octet) => octet > 255)) return false;
  if (BLOCKED_LAN_RANGES.some((range) => range.test(ip))) return false;

  return PRIVATE_LAN_RANGES.some((range) => range.test(ip));
}
