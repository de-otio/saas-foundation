# 09 — Region and residency

Region detection (where is the request being served from?) and
residency policy (where must this tenant's data live?). Foundation
provides the detection primitives and the residency lookup shape;
consumers wire them to their tenant table.

## What it owns

- `Region` — a `string` brand for a region identifier (consumer-
  defined: `EU`, `US`, `CN`, or AWS region codes like `eu-central-1`).
- `RegionDetector` — multi-source region detection (CDN-geo header,
  Accept-Language fallback, default).
- `ResidencyPolicy` — the strategy interface for "where does this
  tenant's data live?" The consumer supplies the implementation
  (typically a tenant-table lookup); foundation defines the contract.
- Default region configuration shape (region → endpoints,
  region → timeout overrides) for consumers that want a configurable
  multi-region setup. Stripped of trellis's domain-specific feature-
  flag enum.

## What it does _not_ own

- **Tenant residency _storage_.** The consumer's tenant table holds
  `{ tenantId → residencyRegion }`. Foundation never writes to it.
- **Cross-region data replication.** Out of scope per
  [`../01-scope-and-philosophy.md`](../01-scope-and-philosophy.md)
  ("Multi-region active-active. Foundation supports region-pinning;
  cross-region replication is the consumer's responsibility").
- **Region-specific feature-flag enums.** Trellis's `region-config.ts`
  ships an `AuthenticationFlags` interface with `weChatAuth`,
  `microsoftSSO`, etc. — domain-specific. Foundation's region module
  carries no enums of feature flags. The feature-toggle layer
  ([`./10-feature-toggles.md`](./10-feature-toggles.md)) is the
  storage layer; the _meaning_ of each toggle is the consumer's.
- **Per-region database connection management.** Trellis has
  `database-connection-manager.ts` (660 LOC) that resolves a
  region-specific Prisma client. Per the migration plan
  ([`../08-trellis-migration.md`](../08-trellis-migration.md)), most
  of that can disappear in favour of Prisma's built-in pool. Foundation
  is open to a tiny `RegionSelector<T>` helper if a clean primitive
  emerges; v0.1 does not ship it.

## Design

### `Region` as a branded string

```typescript
declare const RegionBrand: unique symbol;
export type Region = string & { readonly [RegionBrand]: true };

/** Format-only validator: 2–32 chars, `[A-Za-z0-9-]` only. */
export function region(value: string): Region;
export function isRegion(value: unknown): value is Region;
```

Two layers of validation:

1. **Format**: 2–32 chars, `[A-Za-z0-9-]` only. Matches both
   broad-region codes (`EU`, `US`, `CN`) and AWS region codes
   (`eu-central-1`, `ap-southeast-2`). Enforced by the standalone
   `region(value)` validator above.
2. **Allowlist (optional)**: held by a `RegionRegistry` instance —
   passed into `RegionDetector` and other consumers explicitly, not
   process-global.

```typescript
import { region, RegionRegistry, RegionDetector } from "@de-otio/saas-foundation/region";

const registry = new RegionRegistry({
  allowed: ["EU", "US", "CN"] as const,
  default: "EU",
  countryMapping: {
    /* ... */
  },
});

const r = registry.parse("EU"); // ok, returns Region
registry.parse("EU-WEST"); // throws InvalidRegionError — not in allowed

const detector = new RegionDetector(registry, {
  /* config */
});
```

`RegionRegistry` is an explicit, passable instance rather than
process-global state. The trellis pattern of `configureRegions(...)`
seeded a hidden module-level object that complicates testing
(parallel tests with different allowlists clobber each other) and
goes against the no-singletons posture of foundation generally. The
consumer instantiates one registry at startup and threads it through
the constructors that need it.

The trellis pattern of "if region is unknown, return null and trust
the caller to handle" survives via `regionOrNull(value)` — but the
registry's `parse(value)` throws, because a region that lands on the
request scope must be trustworthy.

### `RegionDetector`

```typescript
export interface RegionDetectorConfig {
  readonly fallbackOrder?: ReadonlyArray<RegionSource>;
}

export type RegionSource =
  | "cdn-geo-header" // CloudFront-Viewer-Country, CF-IPCountry
  | "accept-language" // zh-CN -> CN, de -> EU, etc.
  | "session" // session.dataRegion if available
  | "tenant-residency"; // tenant residency policy (async)

export class RegionDetector {
  constructor(
    registry: RegionRegistry,
    config?: RegionDetectorConfig,
    options?: { residencyPolicy?: ResidencyPolicy },
  );

  /**
   * Sync detection — fast path. Sources limited to
   * cdn-geo-header, accept-language, default.
   */
  detectSync(request: Request): Region;

  /**
   * Async detection — adds tenant-residency to the chain. Only
   * needed when the consumer wants to *override* the request's
   * served-region with the tenant's residency region.
   */
  detect(request: Request, tenantId?: TenantId): Promise<Region>;
}
```

The detector reads the `default`, `allowed`, and `countryMapping`
config from the `RegionRegistry` instance passed in. Different
deployments can construct different registries; tests construct
disposable registries without affecting other tests.

#### Detection order

The default chain:

1. **`cdn-geo-header`** — CloudFront `CloudFront-Viewer-Country` and
   Cloudflare `CF-IPCountry`. Country-code → region mapping is
   consumer-configurable (see "Country-to-region mapping" below).
2. **`accept-language`** — coarse fallback for direct-traffic /
   non-CDN requests. `zh-CN` → `CN`, `de`/`fr`/`es`/`it`/`pt`/`nl` →
   `EU`. Skipped if the consumer doesn't include it in
   `fallbackOrder`.
3. **`default`** — the configured default.

Async-only sources (`session`, `tenant-residency`) are layered on by
the consumer's middleware when they want them:

```typescript
const region = await detector.detect(request, tenantId);
```

`tenant-residency` is the _override_ — even if the request comes
from a US IP, if the tenant's residency is EU, the consumer's
handler must route DB reads to the EU. Foundation only provides the
_lookup_; the consumer-side handler does the routing.

#### Country-to-region mapping

Trellis hardcodes the mapping (`CN` → `CN`, `DE`/`FR`/… → `EU`, etc.).
Foundation makes it consumer-supplied via `RegionRegistry`:

```typescript
const registry = new RegionRegistry({
  allowed: ["EU", "US", "CN"] as const,
  default: "EU",
  countryMapping: {
    CN: "CN",
    HK: "CN", // consumer choice
    TW: "CN",
    US: "US",
    CA: "US",
    MX: "US",
    DE: "EU",
    FR: "EU",
    NL: "EU" /* ... */,
  },
});
```

A country not in the mapping falls through to the next source.

### `ResidencyPolicy`

```typescript
export interface ResidencyPolicy {
  /**
   * Return the residency region for a tenant, or null if the tenant
   * has no specific residency (use the request's region).
   */
  getResidencyRegion(tenantId: TenantId): Promise<Region | null>;
}
```

The consumer implements this against their tenant table:

```typescript
class TenantTableResidencyPolicy implements ResidencyPolicy {
  constructor(private readonly prisma: PrismaClient) {}

  async getResidencyRegion(tenantId: TenantId): Promise<Region | null> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { residencyRegion: true },
    });
    return tenant?.residencyRegion ? region(tenant.residencyRegion) : null;
  }
}
```

Foundation does not ship a default implementation because every
consumer's tenant table looks different. The interface is the
contract; the implementation is the consumer's.

A cached implementation pattern (recommended for prod):

```typescript
class CachedResidencyPolicy implements ResidencyPolicy {
  private readonly cache = new Map<TenantId, { region: Region | null; expires: number }>();
  constructor(
    private readonly inner: ResidencyPolicy,
    private readonly ttlMs = 60_000,
  ) {}

  async getResidencyRegion(tenantId: TenantId): Promise<Region | null> {
    const cached = this.cache.get(tenantId);
    if (cached && cached.expires > Date.now()) return cached.region;
    const r = await this.inner.getResidencyRegion(tenantId);
    this.cache.set(tenantId, { region: r, expires: Date.now() + this.ttlMs });
    return r;
  }
}
```

Foundation ships `CachedResidencyPolicy` as the only canned
implementation, because the cache shape is universal.

### Wiring into `RequestContext`

`RequestContext` ([`../04-shared-vocabulary.md`](../04-shared-vocabulary.md#requestcontext))
has two region fields:

- `region?: string` — where the request is being _served_ (matches
  the inbound geo signals).
- `residencyRegion?: string` — where the tenant's data _lives_ (may
  differ from `region`).

The consumer's middleware populates both at context-construction
time:

```typescript
const requestRegion = detector.detectSync(c.req.raw);
const residency = tenantId ? await residencyPolicy.getResidencyRegion(tenantId) : null;

const context = createRequestContext({
  /* ... */
  region: requestRegion,
  residencyRegion: residency ?? requestRegion,
});
```

Handlers that read/write tenant data check `residencyRegion`, not
`region`. The split is deliberate: a US-served request for an
EU-residency tenant should route DB reads to the EU.

### Endpoint configuration

Trellis ships a `RegionConfig` interface with API/frontend/CDN
endpoints per region. Foundation keeps the shape but consumer-
configurable:

```typescript
export interface RegionEndpoints {
  readonly api: string;
  readonly frontend?: string;
  readonly cdn?: string;
}

export interface RegionTimeouts {
  readonly apiMs?: number;
  readonly databaseMs?: number;
  readonly storageMs?: number;
}

export interface RegionConfig {
  readonly region: Region;
  readonly endpoints: RegionEndpoints;
  readonly timeouts?: RegionTimeouts;
}

export class RegionConfigStore {
  constructor(configs: ReadonlyArray<RegionConfig>);
  get(region: Region): RegionConfig | null;
}
```

This replaces trellis's `region-config.ts` (630 LOC, much of which
is the feature-flag enum that does not graduate). What remains is a
small lookup map; consumers populate it from their environment.

## TypeScript surface

```typescript
export type { Region } from "./types.js";
export { region, regionOrNull, isRegion } from "./types.js";

export interface RegionRegistryOptions {
  readonly allowed: ReadonlyArray<string>;
  readonly default: string;
  readonly countryMapping?: Readonly<Record<string, string>>;
}

export class RegionRegistry {
  constructor(options: RegionRegistryOptions);
  parse(value: string): Region; // throws InvalidRegionError on miss
  parseOrNull(value: string): Region | null;
  getDefault(): Region;
  countryToRegion(country: string): Region | null;
  allowed(): ReadonlyArray<Region>;
}

export interface RegionDetectorConfig {
  /* ... */
}
export class RegionDetector {
  constructor(
    registry: RegionRegistry,
    config?: RegionDetectorConfig,
    options?: { residencyPolicy?: ResidencyPolicy },
  );
  /* ... */
}

export interface ResidencyPolicy {
  getResidencyRegion(tenantId: TenantId): Promise<Region | null>;
}
export class CachedResidencyPolicy implements ResidencyPolicy {
  /* ... */
}

export interface RegionConfig {
  /* ... */
}
export class RegionConfigStore {
  /* ... */
}

export class InvalidRegionError extends Error {}
```

## Caveats

- **Hostname-based region routing is not handled.** The consumer's
  edge (CloudFront / ALB) routes requests to region-local origins
  before they hit foundation; the detector's job is to _recognise_
  the served-region from headers, not to _route_ to it.
- **`cdn-geo-header` lies sometimes.** VPN / proxy / Tor users hit
  the wrong region; the residency policy is the authoritative
  override for tenant-scoped requests.
- **No automatic fallback on regional outages.** If an EU origin is
  unhealthy, foundation does not fail over to US. That's
  infrastructure-layer (Route 53 health checks); foundation pins to
  the tenant's residency.
- **`Region` brand is opaque.** Foundation does not enforce a
  specific code system. A consumer using `eu-central-1`-style codes
  and a consumer using `EU`-style codes do not exchange `Region`
  values directly — they pass them through their respective
  validators.

## Open questions

- **A canonical AWS-region helper (`awsRegion('eu-central-1')`) as a
  refinement of `Region`?** Useful for consumers wanting to derive a
  Secrets-Manager client region from the residency policy. Probably
  yes as a small helper; v0.1 or v0.2.
- **`RegionDetector.detect` returning a richer object
  (`{ region, source, confidence }`) for forensics?** Audit metadata
  could include "this request was routed to EU because of
  `tenant-residency`." Useful; the current return is a bare
  `Region`. Add to v0.2.
- **Per-region rate-limit dimensioning?** Different regions might
  have different rate-limit thresholds (CN with stricter limits, say).
  Achievable today by namespacing rate-limit keys with the region;
  no special foundation support needed.
- **A `region.toAwsRegion()` mapper?** Maps `EU` → `eu-central-1`,
  `US` → `us-east-1`, etc. This is consumer-configurable today; a
  helper that reads the `RegionRegistry` is sugar. Probably ship
  in v0.2.
