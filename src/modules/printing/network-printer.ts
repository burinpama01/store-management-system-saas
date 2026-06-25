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

export function normalizeNetworkPrinterEndpoint(input: { host: string; port?: number | null }) {
  const host = input.host.trim();
  const port = input.port ?? 9100;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid port number");
  }
  if (!isAllowedNetworkPrinterHost(host)) {
    throw new Error("Invalid or disallowed IP address");
  }
  return { host, port };
}

export function probeNetworkPrinter(input: {
  host: string;
  port: number;
  timeoutMs?: number;
}): Promise<{ ok: true; latencyMs: number }> {
  const startedAt = Date.now();
  const timeoutMs = input.timeoutMs ?? 1500;

  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Connection timed out (${timeoutMs}ms)`));
    }, timeoutMs);

    socket.connect(input.port, input.host, () => {
      clearTimeout(timer);
      socket.end();
      resolve({ ok: true, latencyMs: Date.now() - startedAt });
    });

    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
