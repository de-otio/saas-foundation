# 05 — Integration and E2E (the deferred tier)

This tier does **not** run on any PR today and there is no `integration/`
config in the tree yet. That is a deliberate position, not an oversight:
per [`../12-remaining-work.md`](../12-remaining-work.md), performance/load
testing is out of scope pre-`1.0.0`, and real-cloud integration is held
back until the cost of *not* having it shows up as incidents. This document
specifies what the tier would be, so that when the trigger fires the design
is already made.

## Why it's deferred, honestly

- **The per-PR layers already cover composition.** Layer 9 (bundle
  integrity + example synth) proves the packages install and synthesise as
  published. Layers 4–6 prove we issue correct AWS commands and synthesise
  correct templates. The residual risk is "does real AWS behave as the
  mock assumed", which is real but narrow.
- **Real-cloud tests are slow, costly, and flaky-prone.** They violate the
  per-PR determinism contract (P2) by construction, so they must live in a
  separate config and a separate cadence regardless.
- **No single deployed app exists** to anchor an E2E suite — this is a
  library. E2E here means "deploy a reference stack and exercise it",
  which is itself test infrastructure to build and maintain.

## The separate config

When built, this tier lives behind a dedicated vitest project (e.g.
`vitest.integration.config.ts` per package, or an `integration/` directory
excluded from the default `include`). It is **opt-in**: run on a schedule,
on a release-candidate branch, or manually — never on every PR. It is
exempt from the no-network rule but inherits every other determinism rule
(seeded randomness, pinned clocks where the assertion allows, no
order-dependence).

Two execution backends, in increasing fidelity / cost:

1. **LocalStack** for the AWS-primitive paths (DynamoDB, SQS, S3, Secrets
   Manager, SSM). Fast enough to run nightly; covers most of `foundation`.
2. **A deployed reference stack** (the `examples/shared-distribution`
   topology) in a disposable `dev` account for the paths LocalStack can't
   credibly fake — Cognito `CUSTOM_AUTH`, Lambda@Edge, CloudFront, SES.
   Torn down after the run (the multi-env mandate makes `dev` disposable).

## Risk-ranked scenario list

In priority order — the highest are the ones where mock-vs-reality drift
would be a security or data-integrity incident, not just a bug:

1. **Edge auth actually blocks an unauthenticated request** at a real
   CloudFront + Lambda@Edge, and admits a valid one. A bypass exposes
   private origins; the unit tests assert the handler logic but not the
   real edge wiring. *(deployed stack)*
2. **Full magic-link round-trip** on real Cognito `CUSTOM_AUTH`:
   create → email (SES sandbox) → verify → session cookie → edge admits.
   The single most consumer-visible flow. *(deployed stack)*
3. **Multi-pool JWT verification against live JWKS** — real key rotation,
   real issuer metadata, cross-pool rejection. *(deployed stack; or
   recorded JWKS for LocalStack-ish)*
4. **DynamoDB conditional-write semantics under contention** — the
   rate-limiter and the reservations/client-config tables rely on
   conditional writes and TTL; LocalStack exercises the conditional-expression
   behaviour the mock can't. *(LocalStack)*
5. **Audit multi-store fan-out and retention/TTL** against a real table —
   that records actually expire and quarantine routing holds. *(LocalStack)*
6. **SES bounce handling** end-to-end (bounce notification → handler →
   suppression). *(deployed stack, SES sandbox)*
7. **OIDC issuer probe SSRF defence against a real redirector** — confirm
   the private-IP refusal holds when a real server issues a 302 to an
   internal address. *(deployed stack / controlled test server)*

## Trigger conditions to invest

Build the tier (start with LocalStack, scenarios 4–5) when **any** of:

- an incident traces to mock-vs-reality drift the per-PR suite could not
  have caught;
- approaching `1.0.0` and committing to the stability guarantees that a
  GA implies;
- a consumer reports an integration defect in a path that unit tests
  marked green;
- a change to the edge-auth or magic-link flow that the team is not
  comfortable shipping on synth-only evidence.

Build the deployed-stack tier (scenarios 1–3, 6–7) only after the
LocalStack tier exists and the magic-link/edge code is changing often
enough that synth-only confidence is the bottleneck.

## What this tier will never be

- A replacement for the per-PR layers. Integration tests are a backstop for
  the narrow "reality differs from mock" risk, not the primary
  verification instrument.
- A performance/load suite — that remains explicitly out of scope until
  there is a stated SLO to test against.
- A gate that blocks ordinary PRs. Its slowness and external dependencies
  make it a scheduled / release-candidate gate, never a per-commit one.
