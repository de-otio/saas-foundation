/**
 * The single canonical JWT signing-algorithm allowlist for vestibulum.
 *
 * Both the admin-plane OIDC discovery probe (`discovery/oidc-probe.ts`) and
 * the auth-hot-path issuer verifier (`verify/issuer-verifier.ts`) import this
 * one constant so the probe-time and verify-time allowlists can never drift.
 *
 * ## Why an explicit allowlist is load-bearing (not belt-and-suspenders)
 *
 * `aws-jwt-verify` (5.x) will happily verify **RS/PS/ES *and* EdDSA**
 * signatures — its `supportedSignatureAlgorithms` set includes `EdDSA`, and it
 * accepts RSA-PSS (`PS*`) tokens when the JWKS advertises the matching key. The
 * JWK-key-type check is therefore **not** the gate. This set is: only the
 * RSASSA-PKCS1-v1_5 (`RS*`) and ECDSA (`ES*`) families are permitted. It
 * excludes `EdDSA`, `PS*`, `HS*`, and `none`. The verifier asserts the JWT
 * header `alg` is a member of this set in its `customJwtCheck`.
 *
 * `none` is additionally rejected structurally by the library (it is not a
 * supported signature algorithm); `HS*` cannot be confused against a JWKS
 * because there is no symmetric key in a JWKS to match. The residual risk this
 * set closes is `EdDSA` / `PS256`, which the library *would* otherwise accept.
 */
export const PERMITTED_ALGS: ReadonlySet<string> = new Set([
  "RS256",
  "RS384",
  "RS512",
  "ES256",
  "ES384",
  "ES512",
]);
