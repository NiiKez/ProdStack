# Azure service wrappers

Thin facade over `@azure/arm-appcontainers` (and future siblings) so the rest
of the backend never touches the SDK directly.

## Stub vs real

The active implementation is selected by `AZURE_STUB`:

- `AZURE_STUB=true` (local dev + tests) — stub mode. Calls are logged via a
  local `pino({ name: 'azure-stub' })` instance, sleep ~50ms, and return
  deterministic `{ name, liveUrl: https://<name>.stub.prodstack.local }`
  refs. No Azure credentials required.
- `AZURE_STUB=false` (deployed) — real mode. Lazily constructs a singleton
  `ContainerAppsAPIClient` using `DefaultAzureCredential`, which picks up
  the API Container App's system-assigned managed identity. Service
  Principals are not used — the deployment tenant blocks them.

## Env knobs

| Var | Purpose |
| --- | --- |
| `AZURE_STUB` | `true` keeps everything offline; `false` enables real SDK calls. |
| `AZURE_SUBSCRIPTION_ID` | Required in real mode. |
| `AZURE_RESOURCE_GROUP` | Required in real mode (`prodstack`). |
| `AZURE_REGION` | Container App location (defaults to `francecentral`). |
| `CONTAINER_APPS_ENV_ID` | Managed Environment resource ID; required in real mode. |
