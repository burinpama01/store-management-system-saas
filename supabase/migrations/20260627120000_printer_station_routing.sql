-- Multi-printer station routing + auto-print.
-- Each kitchen station can be bound to a physical printer (bar, hot kitchen,
-- etc.); orders are split per station and each station's ticket is printed to
-- its own printer. Receipts can auto-print on payment, station tickets on send.

alter table kitchen_stations
  add column if not exists printer_id uuid references printers(id) on delete set null;

create index if not exists kitchen_stations_printer_id_idx
  on kitchen_stations(printer_id);

alter table receipt_settings
  add column if not exists auto_print_receipt boolean not null default false,
  add column if not exists auto_print_station_tickets boolean not null default false;
