-- StoreOS Print Hub: Bluetooth printer support.
-- Lets a store whose POS runs on iPad/iOS (no Web Bluetooth) print to a
-- Bluetooth thermal printer that is paired to the cashier PC as a Windows
-- Bluetooth SPP COM port. Tablets enqueue by printer id; the Hub agent on the
-- cashier PC writes the job to that COM port (instead of a LAN TCP socket).

-- 1. Print jobs gain a transport discriminator + a device (COM port) target.
--    Existing rows are LAN/IP jobs, so 'ip' is the default and target_host
--    stays populated for them; Bluetooth jobs carry target_device instead.
alter table print_jobs
  add column if not exists target_kind text not null default 'ip'
    check (target_kind in ('ip', 'bt')),
  add column if not exists target_device text;

-- Bluetooth jobs have no LAN host, so the host can no longer be required.
alter table print_jobs alter column target_host drop not null;

-- 2. A Bluetooth printer paired to the cashier PC exposes an outgoing
--    Bluetooth SPP COM port (e.g. "COM5"). Stored per-printer so the enqueue
--    endpoint can resolve it from the printer id the tablet sends.
alter table printers
  add column if not exists hub_bluetooth_port text;
