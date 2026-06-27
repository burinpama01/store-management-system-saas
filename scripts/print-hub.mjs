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
const SEND_TIMEOUT_MS = 30000;
const DEFAULT_POLL_INTERVAL_MS = 2500;
const ERROR_BACKOFF_MS = 8000;

function clampInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

// Pace bytes to the printer. A cheap thermal printer's input buffer overruns
// when a large raster (e.g. a receipt with a logo/QR image) is written in one
// shot over TCP -- it loses sync mid GS v 0 and prints the rest of the raster as
// garbage characters. Writing in small chunks with a short delay (like the
// Bluetooth client) lets the printer keep up. Tunable via env if a printer
// needs to go slower.
const PRINT_CHUNK_BYTES = clampInt(process.env.STOREOS_HUB_CHUNK_BYTES, 1024);
const PRINT_CHUNK_DELAY_MS = clampInt(process.env.STOREOS_HUB_CHUNK_DELAY_MS, 20);

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

export function sendToSocket(host, port, data, options = {}) {
  const connectTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const chunkBytes = options.chunkBytes ?? PRINT_CHUNK_BYTES;
  const chunkDelayMs = options.chunkDelayMs ?? PRINT_CHUNK_DELAY_MS;
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let done = false;
    let timer = setTimeout(() => settle(new Error(`Connection timed out (${connectTimeoutMs}ms)`)), connectTimeoutMs);
    function settle(err) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) {
        socket.destroy();
        reject(err);
      } else {
        socket.end();
        resolve();
      }
    }
    socket.on("error", settle);
    socket.connect(port, host, async () => {
      clearTimeout(timer);
      timer = setTimeout(() => settle(new Error(`Print send timed out (${SEND_TIMEOUT_MS}ms)`)), SEND_TIMEOUT_MS);
      try {
        for (let offset = 0; offset < data.length && !done; offset += chunkBytes) {
          const end = Math.min(offset + chunkBytes, data.length);
          await new Promise((res, rej) => socket.write(data.subarray(offset, end), (e) => (e ? rej(e) : res())));
          if (chunkDelayMs > 0 && end < data.length) {
            await new Promise((res) => setTimeout(res, chunkDelayMs));
          }
        }
        settle();
      } catch (err) {
        settle(err);
      }
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
  const configPath = join(here, "print-hub.config.json");
  let fileConfig = {};
  try {
    // Strip a UTF-8 BOM (PowerShell/Notepad may prepend one) before parsing,
    // otherwise JSON.parse throws on the leading U+FEFF.
    const raw = readFileSync(configPath, "utf8").replace(/^\uFEFF/, "");
    fileConfig = JSON.parse(raw);
  } catch (err) {
    // Missing file is fine (env vars may supply config); surface parse errors.
    if (err && err.code !== "ENOENT") {
      console.error(`Could not read ${configPath}: ${err instanceof Error ? err.message : err}`);
    }
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
  console.log(`StoreOS Print Hub started for store ${config.storeId} -> ${config.serverUrl}`);
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
