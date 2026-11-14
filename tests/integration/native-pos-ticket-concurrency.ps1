param(
  [string]$Database = 'storeos_native_verify_20261006_2230',
  [string]$Container = 'supabase_db_Store_management_system_saas'
)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'PowerShell 7 is required for ArgumentList and UTF8 process I/O.' }
if ($Database -notmatch '^storeos_native_verify_[a-zA-Z0-9_]+$') { throw 'An isolated verification database is required.' }
if ($Container -ne 'supabase_db_Store_management_system_saas') { throw 'Only the approved local database container is allowed.' }

function Start-Sql([string]$Sql) {
  $info = [System.Diagnostics.ProcessStartInfo]::new()
  $info.FileName = 'docker'
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardInput = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.StandardInputEncoding = [System.Text.UTF8Encoding]::new($false)
  $info.StandardOutputEncoding = [System.Text.UTF8Encoding]::new($false)
  $info.StandardErrorEncoding = [System.Text.UTF8Encoding]::new($false)
  foreach ($argument in @('exec', '-i', $Container, 'psql', '-U', 'supabase_admin', '-d', $Database, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1')) { $info.ArgumentList.Add($argument) }
  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $info
  if (-not $process.Start()) { throw 'Could not launch the local SQL connection.' }
  $stdout = $process.StandardOutput.ReadToEndAsync()
  $stderr = $process.StandardError.ReadToEndAsync()
  $process.StandardInput.WriteLine($Sql)
  $process.StandardInput.Close()
  return @{ Process = $process; Output = $stdout; Error = $stderr }
}

function Finish-Sql($Job) {
  if (-not $Job.Process.WaitForExit(30000)) {
    $Job.Process.Kill()
    throw 'Local concurrency SQL connection timed out after 30 seconds.'
  }
  $output = $Job.Output.GetAwaiter().GetResult()
  $errorText = $Job.Error.GetAwaiter().GetResult()
  $exitCode = $Job.Process.ExitCode
  $Job.Process.Dispose()
  if ($exitCode -ne 0) { throw "Local SQL failed (exit $exitCode): $errorText" }
  return $output.Trim()
}

function Invoke-Sql([string]$Sql) { return Finish-Sql (Start-Sql $Sql) }
function New-Id { return [guid]::NewGuid().ToString() }
$actorId = New-Id
$orgId = New-Id
$storeId = New-Id
$ticketId = New-Id
$replayTicketId = New-Id
$firstClaim = New-Id
$secondClaim = New-Id
$replayClaim = New-Id
$cart = '{"storeId":"' + $storeId + '","subtotal":65,"discount":0,"total":65,"items":[{"productId":"' + (New-Id) + '","quantity":1,"unitPrice":65,"totalPrice":65,"modifiers":[]}]}'
$guard = "do `$`$ begin if current_database() <> '$Database' then raise exception 'isolated verification database required'; end if; end `$`$;"
$claimsSetting = "SET request.jwt.claims = '{`"role`":`"service_role`"}';"

$fixture = @"
$guard
$claimsSetting
insert into auth.users(id,email) values('$actorId','concurrency-$actorId@example.invalid');
insert into organizations(id,name,slug,owner_id) values('$orgId','Native concurrency test','concurrency-$orgId','$actorId');
insert into stores(id,organization_id,name,slug) values('$storeId','$orgId','Native concurrency test','concurrency-$storeId');
insert into memberships(organization_id,user_id,store_id,role,joined_at) values('$orgId','$actorId','$storeId','owner',now());
select native_pos_save_ticket('$ticketId','$storeId','$orgId','$actorId','Competing claims','$cart'::jsonb);
select native_pos_save_ticket('$replayTicketId','$storeId','$orgId','$actorId','Same claim replay','$cart'::jsonb);
"@
$savedLines = @((Invoke-Sql $fixture) -split "`r?`n" | Where-Object { $_.StartsWith('{') })
# Preserve PostgreSQL microseconds. ConvertFrom-Json may coerce ISO strings to
# DateTime; subsequent string conversion would lose the optimistic version.
$stamps = @($savedLines | ForEach-Object { [regex]::Match($_, '"updatedAt":\s*"([^"]+)"').Groups[1].Value })
if ($savedLines.Count -ne 2 -or -not $stamps[0] -or -not $stamps[1]) { throw 'Synthetic native parked ticket setup did not return two saved tickets.' }

function Claim-Sql([string]$Ticket, [string]$Claim, [string]$Stamp) {
  # The first connection holds the exact lock used by the RPC. It cannot commit
  # until pg_stat_activity proves the other connection is blocked on that lock.
  # The second connection then executes the RPC without an artificial delay.
  $applicationName = "native-ticket-race-$Ticket"
  return @"
$guard
$claimsSetting
set application_name = '$applicationName';
begin;
create temporary table race_leader on commit drop as select pg_try_advisory_xact_lock(hashtextextended('$Ticket',0)) as is_leader;
select native_pos_claim_ticket('$Claim','$Ticket','$storeId','$orgId','$actorId','$Stamp'::timestamptz,'$cart'::jsonb,jsonb_build_object('id','$Ticket','label','Concurrent test','lines','[]'::jsonb,'checkoutOperationId','$Claim'));
do `$`$
declare deadline timestamptz := clock_timestamp() + interval '10 seconds';
begin
  if not (select is_leader from race_leader) then return; end if;
  loop
    -- Refresh the statistics snapshot on every attempt in this transaction.
    perform pg_stat_clear_snapshot();
    if exists(select 1 from pg_stat_activity where application_name='$applicationName' and pid <> pg_backend_pid() and state='active' and wait_event_type='Lock' and wait_event='advisory'
      and pg_backend_pid() = any(pg_blocking_pids(pid))) then exit; end if;
    if clock_timestamp() > deadline then raise exception 'concurrent advisory lock overlap not observed'; end if;
    perform pg_sleep(0.02);
  end loop;
end `$`$;
select 'OVERLAP_VERIFIED' where (select is_leader from race_leader);
commit;
"@
}

function Run-Pair([string]$SqlA, [string]$SqlB) {
  $jobA = Start-Sql $SqlA
  try { $jobB = Start-Sql $SqlB } catch { $launchFailure = $_; try { $null = Finish-Sql $jobA } catch { }; throw $launchFailure }
  $failure = $null
  try { $outputA = Finish-Sql $jobA } catch { $failure = $_ }
  try { $outputB = Finish-Sql $jobB } catch { if (-not $failure) { $failure = $_ } }
  if ($failure) { throw $failure }
  if (@($outputA, $outputB | Where-Object { $_ -match 'OVERLAP_VERIFIED' }).Count -ne 1) { throw 'Exactly one winner must observe the other connection blocked before commit.' }
  $jsonA = ($outputA -split "`r?`n" | Where-Object { $_.StartsWith('{') } | Select-Object -First 1)
  $jsonB = ($outputB -split "`r?`n" | Where-Object { $_.StartsWith('{') } | Select-Object -First 1)
  if (-not $jsonA -or -not $jsonB) { throw 'Concurrent connections did not each return one claim result.' }
  return @($jsonA | ConvertFrom-Json; $jsonB | ConvertFrom-Json)
}

$competing = Run-Pair (Claim-Sql $ticketId $firstClaim $stamps[0]) (Claim-Sql $ticketId $secondClaim $stamps[0])
$winners = @($competing | Where-Object { $_.checkoutOperationId })
$conflicts = @($competing | Where-Object { $_.error })
if ($winners.Count -ne 1 -or $conflicts.Count -ne 1) { throw ('Different claims must produce exactly one success and one conflict. Results: ' + ($competing | ConvertTo-Json -Depth 10 -Compress)) }

$replayed = Run-Pair (Claim-Sql $replayTicketId $replayClaim $stamps[1]) (Claim-Sql $replayTicketId $replayClaim $stamps[1])
if (@($replayed | Where-Object { $_.error }).Count -ne 0 -or $replayed[0].checkoutOperationId -ne $replayClaim -or $replayed[1].checkoutOperationId -ne $replayClaim -or ($replayed[0] | ConvertTo-Json -Depth 10 -Compress) -ne ($replayed[1] | ConvertTo-Json -Depth 10 -Compress)) { throw 'Concurrent same-claim retries must return the identical durable result.' }

$counts = Invoke-Sql @"
$guard
select jsonb_build_object('claims',(select count(*) from native_pos_ticket_claims where store_id='$storeId'),'sources',(select count(*) from native_pos_saved_tickets where store_id='$storeId'),'webTickets',(select count(*) from pos_saved_tickets where store_id='$storeId'));
"@
$verified = $counts | ConvertFrom-Json
if ($verified.claims -ne 2 -or $verified.sources -ne 0 -or $verified.webTickets -ne 0) { throw 'Expected exactly two durable claims, zero consumed source tickets, and no legacy web copies.' }
Write-Output 'PASS: Different claims: pg_stat_activity + pg_blocking_pids proved advisory-lock overlap before winner commit; one winner and one conflict.'
Write-Output 'PASS: Same claim: pg_stat_activity + pg_blocking_pids proved advisory-lock overlap before winner commit; identical durable result.'
Write-Output 'PASS: Two durable claims; zero source tickets; zero legacy web tickets.'
Write-Output "Synthetic fixture retained in isolated database $Database (store $storeId)."
