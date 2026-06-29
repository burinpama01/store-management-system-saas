# Store OS — Public REST API v1

Read-only REST API for Enterprise organizations. Manage keys at **ตั้งค่า → API**
(`/settings/integrations`). The key is shown in full once at creation — store it
securely; only a hash is kept server-side.

## Authentication

Send the key on every request:

```
Authorization: Bearer sk_live_xxxxxxxxxxxxxxxx
```

(`x-api-key: sk_live_...` is also accepted.)

- `401` — missing or invalid/revoked key
- `403` — the organization's plan no longer includes API access (Enterprise only)

## Pagination

All list endpoints accept `?limit` (1–200, default 50) and `?offset` (default 0).
Responses are envelopes:

```json
{ "data": [ ... ], "meta": { "limit": 50, "offset": 0, "count": 12 } }
```

## Endpoints

| Method | Path | Returns |
|--------|------|---------|
| GET | `/api/v1/products` | products (id, store_id, category_id, name, base_price, is_active) |
| GET | `/api/v1/orders` | orders; optional `?from=YYYY-MM-DD&to=YYYY-MM-DD` on created_at |
| GET | `/api/v1/inventory` | product variants with stock (id, product_id, name, stock_quantity, track_stock, is_active) |
| GET | `/api/v1/customers` | customers (id, store_id, name, phone, email, created_at) |

All data is automatically scoped to the organization that owns the key.

## Example

```bash
curl https://store-os-manage.vercel.app/api/v1/orders?from=2026-06-01&to=2026-06-30 \
  -H "Authorization: Bearer sk_live_xxxxxxxxxxxxxxxx"
```

## Notes

- v1 is read-only. Write endpoints are planned for a later version.
- Rate limiting is not yet enforced; avoid tight polling loops.
