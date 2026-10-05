import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

// Read-only database export. Plaintext archive/key never goes to disk or stdout.
process.loadEnvFile('D:/Store management system saas/.env.local');
const source = new URL(process.env.SUPABASE_DATABASE_URL);
const container = 'supabase_db_Store_management_system_saas';
const env = { ...process.env, PGHOST: source.hostname, PGPORT: source.port || '5432',
  PGUSER: decodeURIComponent(source.username), PGPASSWORD: decodeURIComponent(source.password),
  PGDATABASE: source.pathname.slice(1) || 'postgres', PGSSLMODE: 'require' };
const args = ['exec', ...['PGHOST','PGPORT','PGUSER','PGPASSWORD','PGDATABASE','PGSSLMODE'].flatMap(k => ['-e',k]),
  container, 'pg_dump', '--format=custom', '--no-owner'];
const dump = spawnSync('docker', args, { env, maxBuffer: 256 * 1024 * 1024, timeout: 180000 });
if (dump.status !== 0 || !dump.stdout?.subarray(0,5).equals(Buffer.from('PGDMP'))) {
  console.log(JSON.stringify({ ok: false, stage: 'dump', exit: dump.status })); process.exit(1);
}
const key = crypto.randomBytes(32), iv = crypto.randomBytes(12);
const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
const encrypted = Buffer.concat([cipher.update(dump.stdout), cipher.final()]);
const tag = cipher.getAuthTag();
const wrap = spawnSync('powershell.exe', ['-NoProfile','-NonInteractive','-Command',
  'Add-Type -AssemblyName System.Security; $k=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $w=[Security.Cryptography.ProtectedData]::Protect($k,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Write([Convert]::ToBase64String($w))'],
  { input: key.toString('base64'), encoding: 'utf8', timeout: 30000 });
if(wrap.status !== 0 || !wrap.stdout.trim()) { console.log(JSON.stringify({ok:false,stage:'key-protection'})); process.exit(1); }
const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv); decipher.setAuthTag(tag);
const verified = Buffer.concat([decipher.update(encrypted), decipher.final()]);
const listing = spawnSync('docker', ['exec','-i',container,'pg_restore','--list'], { input: verified, maxBuffer: 16*1024*1024, timeout: 30000 });
if(listing.status !== 0) { console.log(JSON.stringify({ok:false,stage:'archive-verification'})); process.exit(1); }
const directory = path.resolve('artifacts/private-db-backups'); fs.mkdirSync(directory,{recursive:true});
const stem = 'storeos-' + new Date().toISOString().replace(/[:.]/g,'-');
const output = path.join(directory,stem+'.dump.enc');
fs.writeFileSync(output,Buffer.concat([Buffer.from('STOREOS1'),iv,tag,encrypted]),{flag:'wx'});
fs.writeFileSync(output+'.key.dpapi',wrap.stdout.trim(),{flag:'wx'});
console.log(JSON.stringify({ok:true,file:output,keyProtection:'Windows DPAPI CurrentUser',cipher:'AES-256-GCM',bytes:encrypted.length,
  sha256:crypto.createHash('sha256').update(dump.stdout).digest('hex'),archiveEntries:listing.stdout.toString().split('\n').filter(x=>/^\d+;/.test(x)).length}));
key.fill(0); dump.stdout.fill(0); verified.fill(0);
