# HighLevel external Chinvat module

Staging implementation of a maximum-surface HighLevel API v2 adapter. It is intentionally
not installed in the Chinvat repository yet.

## Configuration

- `accessToken`: Private Integration token created for the selected sub-account.
- `locationId`: selected sub-account's Location ID.
- `apiVersion`: HighLevel `Version` header; defaults to current `v3`. Generic operations
  accept a per-request override for date-versioned endpoints.
- `timeoutMs`: request timeout; defaults to 60 seconds.

The module always sends requests to `https://services.leadconnectorhq.com`.

## Operations

- `capability_inventory` maps catalogued API families and known account-bound controls.
- `connection_health` verifies the selected location.
- `resource_list`, `resource_get`, `resource_create`, `resource_update`, and
  `resource_delete` provide location-aware access to common resource families.
- `api_get`, `api_post`, `api_put`, `api_patch`, and `api_delete` provide the maximum-surface
  escape hatch for newly discovered or less common v2 routes while retaining the fixed host.

The catalog is a routing aid, not an entitlement claim. Actual availability is determined by
the token's scopes, plan, product rollout, sub-account ownership, and HighLevel API behavior.

## Deterministic verification

Run:

```powershell
node --test .\smoke.test.mjs
```

The smoke suite mocks network access. It does not require or expose a live token.

Live sub-account trial findings are kept in the operator's private notes
and are not published in this repository.
