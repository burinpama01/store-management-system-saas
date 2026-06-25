#!/usr/bin/env node
import http from "node:http";
import net from "node:net";

const HOST = "127.0.0.1";
const PORT = Number.parseInt(process.env.STOREOS_PRINT_BRIDGE_PORT ?? "17878", 10);
const MAX_PRINT_JOB_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_ALLOWED_ORIGINS = [
  "https://store-os-manage.vercel.app",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

const allowedOrigins = (process.env.STOREOS_PRINT_BRIDGE_ORIGINS ?? DEFAULT_ALLOWED_ORIGINS.join(","))
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

function isAllowedOrigin(origin) {
  return !origin || allowedOrigins.includes(origin);
}

function isAllowedPrintOrigin(origin) {
  if (!origin) return false;
  return allowedOrigins.includes(origin);
}

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    if (req.headers["access-control-request-private-network"] === "true") {
      res.setHeader("Access-Control-Allow-Private-Network", "true");
    }
  }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
}

function sendJson(req, res, status, body) {
  setCorsHeaders(req, res);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function isAllowedNetworkPrinterHost(ip) {
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) return false;
  const octets = ip.split(".").map(Number);
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  if (/^127\.|^169\.254\.|^0\.|^255\./.test(ip)) return false;
  return /^10\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || /^192\.168\./.test(ip);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > Math.ceil((MAX_PRINT_JOB_BYTES * 4) / 3) + 4096) {
        reject(new Error("Print job too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function decodePrintJobBase64(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error("Invalid print job");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.length > MAX_PRINT_JOB_BYTES) {
    throw new Error("Print job too large");
  }
  return bytes;
}

function sendToSocket(host, port, data) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Connection timed out (${DEFAULT_TIMEOUT_MS}ms)`));
    }, DEFAULT_TIMEOUT_MS);

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

async function handlePrint(req, res) {
  if (!isAllowedPrintOrigin(req.headers.origin)) {
    return sendJson(req, res, 403, { error: "Origin not allowed" });
  }

  try {
    const body = await readJsonBody(req);
    const host = String(body.host ?? "").trim();
    const port = Number(body.port ?? 9100);
    if (!isAllowedNetworkPrinterHost(host)) throw new Error("Invalid or disallowed IP address");
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port number");
    const bytes = decodePrintJobBase64(body.printJobBase64);
    await sendToSocket(host, port, bytes);
    return sendJson(req, res, 200, { ok: true });
  } catch (error) {
    return sendJson(req, res, 502, { error: error instanceof Error ? error.message : "Print failed" });
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    setCorsHeaders(req, res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    return sendJson(req, res, 200, { ok: true, service: "storeos-print-bridge" });
  }

  if (req.method === "POST" && req.url === "/print") {
    return handlePrint(req, res);
  }

  return sendJson(req, res, 404, { error: "Not found" });
});

server.listen(PORT, HOST, () => {
  console.log(`StoreOS Print Bridge listening on http://${HOST}:${PORT}`);
  console.log(`Allowed origins: ${allowedOrigins.join(", ")}`);
});
