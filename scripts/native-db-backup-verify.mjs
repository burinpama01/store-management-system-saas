import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const file = process.argv[2];
if(!file?.endsWith('.dump.enc')) throw Error('Explicit encrypted archive path required');
const wrapped = fs.readFileSync(file+'.key.dpapi','utf8');
const unwrap = spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',
  'Add-Type -AssemblyName System.Security; $w=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $k=[Security.Cryptography.ProtectedData]::Unprotect($w,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Write([Convert]::ToBase64String($k))'],
  {input:wrapped,encoding:'utf8',timeout:30000});
if(unwrap.status!==0) throw Error('DPAPI recovery failed');
const key = Buffer.from(unwrap.stdout.trim(),'base64');
const encrypted = fs.readFileSync(file);
if(encrypted.subarray(0,8).toString()!=='STOREOS1') throw Error('Unknown backup format');
const decipher=crypto.createDecipheriv('aes-256-gcm',key,encrypted.subarray(8,20));
decipher.setAuthTag(encrypted.subarray(20,36));
const archive=Buffer.concat([decipher.update(encrypted.subarray(36)),decipher.final()]);
const container='supabase_db_Store_management_system_saas';
const listing=spawnSync('docker',['exec','-i',container,'pg_restore','--list'],{input:archive,maxBuffer:16*1024*1024,timeout:30000});
if(listing.status!==0) throw Error('Recovered archive unreadable');
console.log(JSON.stringify({recovered:true,sha256:crypto.createHash('sha256').update(archive).digest('hex')}));
if(process.argv.includes('--restore')) {
  // Fresh isolated DB only. No cron schema, jobs or external worker is restored.
  const db='storeos_native_verify_restore_'+Date.now();
  const create=spawnSync('docker',['exec',container,'createdb','-U','postgres',db],{timeout:30000});
  if(create.status!==0) throw Error('Isolated database creation failed');
  const init=spawnSync('docker',['exec',container,'psql','-U','postgres','-d',db,'-v','ON_ERROR_STOP=1','-c',
    'create schema if not exists extensions; create schema if not exists auth; create extension if not exists "uuid-ossp" with schema extensions; create extension if not exists pgcrypto with schema extensions; create publication supabase_realtime;'],{timeout:30000});
  if(init.status!==0) throw Error('Isolated extension setup failed');
  const restore=spawnSync('docker',['exec','-i',container,'pg_restore','-U','postgres','-d',db,'--no-owner','--no-acl','--schema=public','--schema=auth','--exit-on-error'],{input:archive,maxBuffer:8*1024*1024,timeout:180000});
  if(restore.status!==0) { console.log(JSON.stringify({restored:false,database:db,stage:'restore',exit:restore.status})); process.exit(1); }
  const counts=spawnSync('docker',['exec',container,'psql','-U','postgres','-d',db,'-Atc',
    "select 'users',count(*) from auth.users union all select 'orders',count(*) from public.orders union all select 'payments',count(*) from public.payments;"],{encoding:'utf8',timeout:30000});
  if(counts.status!==0) throw Error('Restored data checks failed');
  console.log(JSON.stringify({restored:true,database:db,counts:counts.stdout.trim().split('\n')}));
}
key.fill(0);archive.fill(0);
