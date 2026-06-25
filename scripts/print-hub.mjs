#!/usr/bin/env node
// StoreOS Print Hub agent.
// Runs on the store's cashier PC / mini-PC. Long-polls the StoreOS server for
// print jobs enqueued by tablet/iPad POS (which cannot reach a LAN printer over
// HTTPS), then prints each claimed job over TCP and acks the result.
//
// Config: scripts/print-hub.config.json next to this file, or STOREOS_HUB_* env.
//   { "serverUrl": "https://store-os-manage.vercel.app",
//     "storeId": "<uuid>", "hubToken": "<token>", "pollIntervalMs": 2500 }

import net from "node:net";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_PRINT_JOB_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_POLL_INTERVAL_MS = 2500;
const ERROR_BACKOFF_MS = 8000;

const PRIVATE_LAN_RANGES = [/^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./];
const BLOCKED_LAN_RANGES = [/^127\./, /^169\.254\./, /^0\./, /^255\./];

export function isAllowedNetworkPrinterHost(ip) {
  if (typeof ip !== "string" || !/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) return false;
  const octets = ip.split(".").map(Number);
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  if (BLOCKED_LAN_RANGES.some((range) => range.test(ip))) return false;
  return PRIVATE_LAN_RANGES.some((range) => range.test(ip));
}

export function decodePrintJobBase64(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error("Invalid print job");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.length > MAX_PRINT_JOB_BYTES) {
    throw new Error("Print job too large");
  }
  return bytes;
}

export function sendToSocket(host, port, data, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Connection timed out (${timeoutMs}ms)`));
    }, timeoutMs);
    socket.connect(port, host, () => {
      socket.write(data, (err) => {
        clearTimeout(timer);
        socket.end();
        if (err) reject(err);
        else resolve();
      });
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Runs one poll cycle: claim jobs, print each, ack the result. Pure w.r.t. its
 * injected `fetchImpl` and `printJob`, so it can be unit-tested without sockets.
 * Returns the number of jobs processed (and any auth/transport failure).
 */
export async function runPollCycle({ config, fetchImpl, printJob }) {
  const { serverUrl, storeId, hubToken } = config;
  const pollRes = await fetchImpl(`${serverUrl}/api/print/hub/poll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ storeId, hubToken }),
  });

  if (pollRes.status === 401) return { ok: false, authFailed: true, processed: 0 };
  if (!pollRes.ok) return { ok: false, processed: 0, status: pollRes.status };

  const body = await pollRes.json();
  const jobs = Array.isArray(body?.jobs) ? body.jobs : [];

  let processed = 0;
  for (const job of jobs) {
    let ok = true;
    let error = null;
    try {
      if (!isAllowedNetworkPrinterHost(job.host)) throw new Error("Invalid or disallowed IP address");
      const bytes = decodePrintJobBase64(job.printJobBase64);
      await printJob(job.host, job.port ?? 9100, bytes);
    } catch (err) {
      ok = false;
      error = err instanceof Error ? err.message : "Print failed";
    }
    await fetchImpl(`${serverUrl}/api/print/hub/ack`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ storeId, hubToken, jobId: job.id, ok, error }),
    });
    processed += 1;
  }
  return { ok: true, processed };
}

function loadConfig() {
  const here = dirname(fileURLToPath(import.meta.url));
  let fileConfig = {};
  try {
    fileConfig = JSON.parse(readFileSync(join(here, "print-hub.config.json"), "utf8"));
  } catch {
    // Fall back to env vars below.
  }
  const config = {
    serverUrl: (process.env.STOREOS_HUB_SERVER_URL ?? fileConfig.serverUrl ?? "").replace(/\/+$/, ""),
    storeId: process.env.STOREOS_HUB_STORE_ID ?? fileConfig.storeId ?? "",
    hubToken: process.env.STOREOS_HUB_TOKEN ?? fileConfig.hubToken ?? "",
    pollIntervalMs: Number(process.env.STOREOS_HUB_POLL_MS ?? fileConfig.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS),
  };
  if (!config.serverUrl || !config.storeId || !config.hubToken) {
    throw new Error("Missing Print Hub config: serverUrl, storeId and hubToken are required");
  }
  return config;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const config = loadConfig();
  console.log(`StoreOS Print Hub started for store ${config.storeId} → ${config.serverUrl}`);
  let running = true;
  process.on("SIGINT", () => { running = false; });
  process.on("SIGTERM", () => { running = false; });

  while (running) {
    let waitMs = config.pollIntervalMs;
    try {
      const result = await runPollCycle({
        config,
        fetchImpl: fetch,
        printJob: (host, port, bytes) => sendToSocket(host, port, bytes),
      });
      if (result.authFailed) {
        console.error("Hub token rejected (401). Check storeId/hubToken in config.");
        waitMs = ERROR_BACKOFF_MS;
      } else if (result.processed > 0) {
        console.log(`Printed ${result.processed} job(s).`);
      }
    } catch (err) {
      console.error(`Poll cycle failed: ${err instanceof Error ? err.message : err}`);
      waitMs = ERROR_BACKOFF_MS;
    }
    await sleep(waitMs);
  }
  console.log("StoreOS Print Hub stopped.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
