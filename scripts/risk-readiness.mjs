#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
const strict = args.includes("--strict");
const envFileArg = args.find((arg) => arg.startsWith("--risk-env-file="));
const envFile = envFileArg ? envFileArg.slice("--risk-env-file=".length) : ".env.local";

const requiredKeys = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "TEST_USER_EMAIL",
  "TEST_USER_PASSWORD",
];

const providerKeys = ["LINE_CHANNEL_ACCESS_TOKEN", "TELEGRAM_BOT_TOKEN"];
const allKeys = [...requiredKeys, ...providerKeys];

function parseEnvFile(path) {
  const env = {};
  const content = readFileSync(path, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, "").trim();
    env[key] = value;
  }
  return env;
}

function keyStatus(env, key) {
  const value = env[key];
  return value && !value.startsWith("#") ? "present" : "missing";
}

const env = existsSync(envFile) ? parseEnvFile(envFile) : null;
const missingKeys = [];

console.log("StoreOS residual risk readiness");
console.log(`ENV_FILE=${env ? "present" : "missing"}`);

for (const key of allKeys) {
  const status = env ? keyStatus(env, key) : "missing";
  if (status === "missing") missingKeys.push(key);
  console.log(`${key}=${status}`);
}

console.log("GATE_LIVE_SUPABASE=manual");
console.log("Live Supabase verification requires explicit approval before remote migrations, RLS checks, or test-user writes.");
console.log("GATE_PROVIDER_DELIVERY=manual");
console.log("Provider delivery verification requires real provider tokens and explicit approval before external sends.");
console.log("GATE_BROWSER_VISUAL_QA=manual");
console.log("Browser visual QA requires dev server, test user login, and screenshot/browser verification.");
console.log("GATE_PRINTER_HARDWARE_QA=manual");
console.log("Printer hardware QA requires a real printer model or lab device before claiming universal printer support.");

const strictBlocked = missingKeys.length > 0;
console.log(`STRICT_STATUS=${strictBlocked ? "blocked" : "ready"}`);

if (strict && strictBlocked) {
  process.exit(1);
}
