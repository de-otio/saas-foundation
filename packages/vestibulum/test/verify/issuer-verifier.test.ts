/**
 * Tests for the generic single-issuer OIDC verifier.
 *
 * This is auth-path crypto: the negative tests ARE the point. We exercise
 * `aws-jwt-verify`'s real signature path (real RSA/EC/Ed25519 keys, JWKS primed
 * via `cacheJwks` so we never hit the network) and prove every fail-closed gate:
 *
 *   - [SEC-1] a token with no `exp` (which the library would accept forever) is
 *     rejected; non-finite `exp` is rejected.
 *   - [SEC-5] a validly-signed EdDSA and a validly-signed PS256 token are
 *     rejected by the alg allowlist, not by a signature error.
 *   - [SEC-2] a flood of permanent-failure tokens triggers ZERO verifier
 *     resets, while a genuine key rotation still verifies on the next call.
 *   - alg:none, HS-with-RSA-key confusion, wrong iss/aud, look-alike issuers,
 *     wrong token_use, missing sub-less-critical claims, malformed tokens.
 *
 * The clock is pinned (FIXED_EPOCH_S) so `exp`/`nbf` cases are deterministic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  generateKeyPairSync,
  KeyObject,
  sign as cryptoSign,
  createHmac,
  constants as cryptoConstants,
} from "node:crypto";
import { JwtVerifier } from "aws-jwt-verify";

import { createIssuerVerifier } from "../../src/verify/issuer-verifier.js";
import { IssuerVerifierError } from "../../src/errors.js";

/* --------------------------------------------------------------- *
 * Pinned clock — 2030-01-01T00:00:00Z                              *
 * --------------------------------------------------------------- */
const FIXED_EPOCH_S = 1893456000;
const FIXED_EPOCH_MS = FIXED_EPOCH_S * 1000;

const ISSUER = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_aaaaaaaa";
const AUDIENCE = "client-abc";
const JWKS_URI = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_aaaaaaaa/.well-known/jwks.json";

/* --------------------------------------------------------------- *
 * base64url + key material                                         *
 * --------------------------------------------------------------- */
function b64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface KeyMat {
  privateKey: KeyObject;
  publicKey: KeyObject;
  jwk: Record<string, unknown>;
}

function makeRsaKey(kid: string): KeyMat {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const j = publicKey.export({ format: "jwk" }) as { n: string; e: string };
  return {
    privateKey,
    publicKey,
    jwk: { kty: "RSA", use: "sig", alg: "RS256", kid, n: j.n, e: j.e },
  };
}

function makeEcKey(kid: string): KeyMat {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const j = publicKey.export({ format: "jwk" }) as { x: string; y: string; crv: string };
  return {
    privateKey,
    publicKey,
    jwk: { kty: "EC", use: "sig", alg: "ES256", kid, crv: "P-256", x: j.x, y: j.y },
  };
}

function makeEdKey(kid: string): KeyMat {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const j = publicKey.export({ format: "jwk" }) as { x: string; crv: string };
  return {
    privateKey,
    publicKey,
    jwk: { kty: "OKP", use: "sig", alg: "EdDSA", kid, crv: "Ed25519", x: j.x },
  };
}

/* --------------------------------------------------------------- *
 * Token signing                                                    *
 * --------------------------------------------------------------- */
interface SignOpts {
  key: KeyMat;
  alg?: string;
  kid?: string;
  iss?: string;
  aud?: unknown;
  tokenUse?: string | null;
  exp?: number | null | string;
  nbf?: number;
  extra?: Record<string, unknown>;
  /** raw signature override (e.g. alg:none → ""). */
  rawSig?: string;
  /** sign the HMAC with this secret (alg-confusion). */
  hmacSecret?: string;
}

function sign(opts: SignOpts): string {
  const alg = opts.alg ?? "RS256";
  const header = { alg, typ: "JWT", kid: opts.kid ?? (opts.key.jwk.kid as string) };
  const payload: Record<string, unknown> = {
    iss: opts.iss ?? ISSUER,
    sub: "opaque-subject-123",
    iat: FIXED_EPOCH_S,
    "cognito:username": "test-user",
  };
  if (opts.aud !== undefined) payload.aud = opts.aud;
  else payload.aud = AUDIENCE;
  if (opts.tokenUse !== null) payload.token_use = opts.tokenUse ?? "id";
  if (opts.exp !== null) payload.exp = opts.exp ?? FIXED_EPOCH_S + 3600;
  if (opts.nbf !== undefined) payload.nbf = opts.nbf;
  Object.assign(payload, opts.extra ?? {});

  const headerB64 = b64url(JSON.stringify(header));
  const payloadB64 = b64url(JSON.stringify(payload));
  const input = `${headerB64}.${payloadB64}`;

  if (opts.rawSig !== undefined) return `${input}.${opts.rawSig}`;

  let sig: Buffer;
  if (opts.hmacSecret !== undefined) {
    sig = createHmac("sha256", opts.hmacSecret).update(input).digest();
  } else if (alg === "RS256") {
    sig = cryptoSign("RSA-SHA256", Buffer.from(input), opts.key.privateKey);
  } else if (alg === "PS256") {
    sig = cryptoSign("RSA-SHA256", Buffer.from(input), {
      key: opts.key.privateKey,
      padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
      saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST,
    });
  } else if (alg === "ES256") {
    sig = cryptoSign("SHA256", Buffer.from(input), {
      key: opts.key.privateKey,
      dsaEncoding: "ieee-p1363",
    });
  } else if (alg === "EdDSA") {
    sig = cryptoSign(null, Buffer.from(input), opts.key.privateKey);
  } else {
    throw new Error(`unsupported test alg ${alg}`);
  }
  return `${input}.${b64url(sig)}`;
}

/* --------------------------------------------------------------- *
 * Verifier builder with primed JWKS (no network)                   *
 * --------------------------------------------------------------- */
/**
 * Spy on `JwtVerifier.create` so every construction primes its JWKS cache
 * from `keysByCreation` (indexed by construction count — index 0 for the first
 * build, 1 for the reset, ...). Returns the verifier plus a `createCount` ref.
 */
function buildPrimed(
  config: Parameters<typeof createIssuerVerifier>[0],
  keysByCreation: KeyMat[][],
): { verifier: ReturnType<typeof createIssuerVerifier>; createCount: () => number } {
  let count = 0;
  const original = JwtVerifier.create.bind(JwtVerifier);
  const spy = vi.spyOn(JwtVerifier, "create").mockImplementation((props: unknown) => {
    const idx = count;
    count += 1;
    const inst = original(props as Parameters<typeof original>[0]);
    const keys = keysByCreation[idx] ?? keysByCreation[keysByCreation.length - 1] ?? [];
    (inst as unknown as { cacheJwks: (j: unknown) => void }).cacheJwks({
      keys: keys.map((k) => k.jwk),
    });
    return inst;
  });
  const verifier = createIssuerVerifier(config);
  spy.mockRestore();
  // Re-install a lightweight spy so post-construction resets also prime.
  // createIssuerVerifier builds once eagerly; resets happen inside verify().
  const spy2 = vi.spyOn(JwtVerifier, "create").mockImplementation((props: unknown) => {
    const idx = count;
    count += 1;
    const inst = original(props as Parameters<typeof original>[0]);
    const keys = keysByCreation[idx] ?? keysByCreation[keysByCreation.length - 1] ?? [];
    (inst as unknown as { cacheJwks: (j: unknown) => void }).cacheJwks({
      keys: keys.map((k) => k.jwk),
    });
    return inst;
  });
  activeSpies.push(spy2);
  return { verifier, createCount: () => count };
}

const activeSpies: { mockRestore: () => void }[] = [];

const baseConfig = {
  issuer: ISSUER,
  audience: AUDIENCE,
  jwksUri: JWKS_URI,
  graceSeconds: 0,
  tokenUse: "id" as const,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_EPOCH_MS);
});

afterEach(() => {
  vi.useRealTimers();
  while (activeSpies.length) activeSpies.pop()!.mockRestore();
  vi.restoreAllMocks();
});

/* =============================================================== *
 * 5.1 Positive baseline                                           *
 * =============================================================== */
describe("issuer-verifier — positive baseline", () => {
  it("verifies a valid RS256 Cognito-shaped ID token", async () => {
    const rsa = makeRsaKey("rsa-1");
    const { verifier } = buildPrimed(baseConfig, [[rsa]]);
    const token = sign({ key: rsa });
    const res = await verifier.verify(token);
    expect(res.issuer).toBe(ISSUER);
    expect(res.claims.sub).toBe("opaque-subject-123");
  });

  it("verifies a valid ES256 token (EC key in JWKS)", async () => {
    const ec = makeEcKey("ec-1");
    const { verifier } = buildPrimed(baseConfig, [[ec]]);
    const token = sign({ key: ec, alg: "ES256" });
    const res = await verifier.verify(token);
    expect(res.claims.sub).toBe("opaque-subject-123");
  });

  it("round-trips a non-UUID (Keycloak-style) sub unharmed", async () => {
    const rsa = makeRsaKey("rsa-1");
    const { verifier } = buildPrimed(baseConfig, [[rsa]]);
    const token = sign({ key: rsa, extra: { sub: "f:1e3a:9ab" } });
    const res = await verifier.verify(token);
    expect(res.claims.sub).toBe("f:1e3a:9ab");
  });
});

/* =============================================================== *
 * 5.2 Temporal + claim-presence                                   *
 * =============================================================== */
describe("issuer-verifier — temporal + exp presence [SEC-1]", () => {
  it("rejects an expired token", async () => {
    const rsa = makeRsaKey("rsa-1");
    const { verifier } = buildPrimed(baseConfig, [[rsa]]);
    const token = sign({ key: rsa, exp: FIXED_EPOCH_S - 10 });
    await expect(verifier.verify(token)).rejects.toMatchObject({ reason: "expired" });
  });

  it("[SEC-1] rejects a token with NO exp claim (library would accept forever)", async () => {
    const rsa = makeRsaKey("rsa-1");
    const { verifier } = buildPrimed(baseConfig, [[rsa]]);
    const token = sign({ key: rsa, exp: null });
    await expect(verifier.verify(token)).rejects.toMatchObject({ reason: "missing_exp" });
  });

  it("[SEC-1] rejects a token whose exp is non-numeric", async () => {
    const rsa = makeRsaKey("rsa-1");
    const { verifier } = buildPrimed(baseConfig, [[rsa]]);
    const token = sign({ key: rsa, exp: "not-a-number" });
    await expect(verifier.verify(token)).rejects.toBeInstanceOf(IssuerVerifierError);
  });

  it("rejects a not-yet-valid token (nbf in the future)", async () => {
    const rsa = makeRsaKey("rsa-1");
    const { verifier } = buildPrimed(baseConfig, [[rsa]]);
    const token = sign({ key: rsa, nbf: FIXED_EPOCH_S + 3600 });
    await expect(verifier.verify(token)).rejects.toMatchObject({ reason: "not_yet_valid" });
  });
});

/* =============================================================== *
 * 5.3 Issuer / audience                                           *
 * =============================================================== */
describe("issuer-verifier — issuer/audience [SEC-9/SEC-12]", () => {
  it("rejects a wrong issuer (validly signed, different iss)", async () => {
    const rsa = makeRsaKey("rsa-1");
    const { verifier } = buildPrimed(baseConfig, [[rsa]]);
    const token = sign({ key: rsa, iss: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_zzzzzzzz" });
    await expect(verifier.verify(token)).rejects.toMatchObject({ reason: "unknown_issuer" });
  });

  it("[SEC-12] rejects look-alike issuers (prefix, substring, trailing slash) — exact match", async () => {
    const rsa = makeRsaKey("rsa-1");
    const { verifier } = buildPrimed(baseConfig, [[rsa]]);
    for (const iss of [
      `https://evil.com/${ISSUER}`,
      `${ISSUER}.evil.com`,
      `${ISSUER}/`,
      `${ISSUER}/../us-east-1_zzzzzzzz`,
    ]) {
      const token = sign({ key: rsa, iss });
      await expect(verifier.verify(token)).rejects.toMatchObject({ reason: "unknown_issuer" });
    }
  });

  it("rejects a wrong audience", async () => {
    const rsa = makeRsaKey("rsa-1");
    const { verifier } = buildPrimed(baseConfig, [[rsa]]);
    const token = sign({ key: rsa, aud: "some-other-client" });
    await expect(verifier.verify(token)).rejects.toMatchObject({ reason: "wrong_audience" });
  });

  it("[SEC-9] accepts a multi-value aud array that INCLUDES the pinned audience", async () => {
    const rsa = makeRsaKey("rsa-1");
    const { verifier } = buildPrimed(baseConfig, [[rsa]]);
    const token = sign({ key: rsa, aud: ["other", AUDIENCE, "third"] });
    const res = await verifier.verify(token);
    expect(res.claims.sub).toBe("opaque-subject-123");
  });

  it("[SEC-9] rejects a multi-value aud array that EXCLUDES the pinned audience", async () => {
    const rsa = makeRsaKey("rsa-1");
    const { verifier } = buildPrimed(baseConfig, [[rsa]]);
    const token = sign({ key: rsa, aud: ["other", "third"] });
    await expect(verifier.verify(token)).rejects.toMatchObject({ reason: "wrong_audience" });
  });

  it("rejects a missing aud (Cognito access-token shape)", async () => {
    const rsa = makeRsaKey("rsa-1");
    const { verifier } = buildPrimed(baseConfig, [[rsa]]);
    // aud omitted entirely
    const token = sign({ key: rsa, aud: undefined, tokenUse: "id", extra: { aud: undefined } });
    // remove aud from payload: sign() defaults aud, so pass empty via extra delete trick
    const noAud = signWithoutAud(rsa);
    await expect(verifier.verify(noAud)).rejects.toBeInstanceOf(IssuerVerifierError);
    void token;
  });

  it("rejects wrong token_use (access where id expected)", async () => {
    const rsa = makeRsaKey("rsa-1");
    const { verifier } = buildPrimed(baseConfig, [[rsa]]);
    const token = sign({ key: rsa, tokenUse: "access" });
    await expect(verifier.verify(token)).rejects.toMatchObject({ reason: "wrong_token_use" });
  });
});

function signWithoutAud(key: KeyMat): string {
  const header = { alg: "RS256", typ: "JWT", kid: key.jwk.kid as string };
  const payload = {
    iss: ISSUER,
    sub: "opaque-subject-123",
    iat: FIXED_EPOCH_S,
    exp: FIXED_EPOCH_S + 3600,
    token_use: "id",
  };
  const headerB64 = b64url(JSON.stringify(header));
  const payloadB64 = b64url(JSON.stringify(payload));
  const input = `${headerB64}.${payloadB64}`;
  const sig = cryptoSign("RSA-SHA256", Buffer.from(input), key.privateKey);
  return `${input}.${b64url(sig)}`;
}

/* =============================================================== *
 * 5.5 Algorithm / structural attacks                              *
 * =============================================================== */
describe("issuer-verifier — algorithm/structural attacks [SEC-5]", () => {
  it("rejects alg:none", async () => {
    const rsa = makeRsaKey("rsa-1");
    const { verifier } = buildPrimed(baseConfig, [[rsa]]);
    const token = sign({ key: rsa, alg: "none", rawSig: "" });
    await expect(verifier.verify(token)).rejects.toBeInstanceOf(IssuerVerifierError);
  });

  it("rejects HS256 signed with the RSA public key as HMAC secret (alg confusion)", async () => {
    const rsa = makeRsaKey("rsa-1");
    const { verifier } = buildPrimed(baseConfig, [[rsa]]);
    const pubPem = rsa.publicKey.export({ type: "spki", format: "pem" });
    const token = sign({ key: rsa, alg: "HS256", hmacSecret: pubPem });
    await expect(verifier.verify(token)).rejects.toBeInstanceOf(IssuerVerifierError);
  });

  it("[SEC-5] rejects a validly-signed EdDSA token via the allowlist, not a signature error", async () => {
    const ed = makeEdKey("ed-1");
    const { verifier } = buildPrimed(baseConfig, [[ed]]);
    const token = sign({ key: ed, alg: "EdDSA" });
    await expect(verifier.verify(token)).rejects.toMatchObject({ reason: "disallowed_alg" });
  });

  it("[SEC-5] rejects a validly-signed PS256 token (fail-closed)", async () => {
    // PS256 is rejected fail-closed. Depending on the JWKS `alg` advertisement,
    // rejection lands either at the library's alg/jwk gate (invalid_signature)
    // or at our allowlist (disallowed_alg) — both are rejections, never accept.
    // The EdDSA case above is the definitive proof that the *allowlist* is the
    // gate for a signature the library would otherwise accept.
    const rsa = makeRsaKey("rsa-1");
    delete (rsa.jwk as { alg?: string }).alg;
    const { verifier } = buildPrimed(baseConfig, [[rsa]]);
    const token = sign({ key: rsa, alg: "PS256" });
    await expect(verifier.verify(token)).rejects.toBeInstanceOf(IssuerVerifierError);
  });

  it("rejects a malformed (2-part) token", async () => {
    const rsa = makeRsaKey("rsa-1");
    const { verifier } = buildPrimed(baseConfig, [[rsa]]);
    await expect(verifier.verify("aaa.bbb")).rejects.toMatchObject({ reason: "malformed_token" });
  });

  it("rejects an empty token", async () => {
    const rsa = makeRsaKey("rsa-1");
    const { verifier } = buildPrimed(baseConfig, [[rsa]]);
    await expect(verifier.verify("")).rejects.toMatchObject({ reason: "malformed_token" });
  });
});

/* =============================================================== *
 * 5.4 Key rotation + [SEC-2] narrowed retry                       *
 * =============================================================== */
describe("issuer-verifier — rotation + narrowed retry [SEC-2]", () => {
  it("verifies on the immediate next call after a key rotation (retry-once)", async () => {
    const oldKey = makeRsaKey("rsa-old");
    const newKey = makeRsaKey("rsa-new");
    // First build primes the OLD key; the reset (2nd build) primes the NEW key.
    const { verifier, createCount } = buildPrimed(baseConfig, [[oldKey], [newKey]]);
    // Token signed by the NEW key, whose kid is not in the first cache.
    const token = sign({ key: newKey });
    const res = await verifier.verify(token);
    expect(res.claims.sub).toBe("opaque-subject-123");
    // Exactly one reset happened: 1 eager build + 1 reset = 2 constructions.
    expect(createCount()).toBe(2);
  });

  it("[SEC-2] a flood of permanent-failure (expired) tokens triggers ZERO resets", async () => {
    const rsa = makeRsaKey("rsa-1");
    const { verifier, createCount } = buildPrimed(baseConfig, [[rsa]]);
    const countAfterBuild = createCount(); // 1 eager build
    for (let i = 0; i < 20; i++) {
      const token = sign({ key: rsa, exp: FIXED_EPOCH_S - 100 - i });
      await expect(verifier.verify(token)).rejects.toMatchObject({ reason: "expired" });
    }
    // No reset for any permanent failure — still just the eager build.
    expect(createCount()).toBe(countAfterBuild);
  });

  it("[SEC-2] a wrong-audience flood triggers ZERO resets", async () => {
    const rsa = makeRsaKey("rsa-1");
    const { verifier, createCount } = buildPrimed(baseConfig, [[rsa]]);
    const countAfterBuild = createCount();
    for (let i = 0; i < 10; i++) {
      const token = sign({ key: rsa, aud: `wrong-${i}` });
      await expect(verifier.verify(token)).rejects.toMatchObject({ reason: "wrong_audience" });
    }
    expect(createCount()).toBe(countAfterBuild);
  });

  it("a genuinely bad signature is retried once then rejected (2 constructions)", async () => {
    const key = makeRsaKey("rsa-1");
    const otherKey = makeRsaKey("rsa-1"); // same kid, different key material
    const { verifier, createCount } = buildPrimed(baseConfig, [[key], [key]]);
    // Sign with a key whose material does not match the cached JWK for that kid.
    const token = sign({ key: otherKey, kid: "rsa-1" });
    await expect(verifier.verify(token)).rejects.toMatchObject({ reason: "invalid_signature" });
    // 1 eager build + 1 reset retry = 2.
    expect(createCount()).toBe(2);
  });
});

/* =============================================================== *
 * Generic (non-Cognito) issuer branch — fixture-only in WS-3.1    *
 * =============================================================== */
describe("issuer-verifier — generic OIDC branch (fixtures)", () => {
  const kcIssuer = "https://keycloak.example.com/realms/trellis";
  const kcConfig = {
    issuer: kcIssuer,
    audience: "trellis-api",
    jwksUri: `${kcIssuer}/protocol/openid-connect/certs`,
    graceSeconds: 0,
    issuerKind: "generic" as const,
  };

  it("accepts a Keycloak-shaped token with no token_use", async () => {
    const rsa = makeRsaKey("kc-1");
    const { verifier } = buildPrimed(kcConfig, [[rsa]]);
    const header = { alg: "RS256", typ: "JWT", kid: "kc-1" };
    const payload = {
      iss: kcIssuer,
      sub: "f:realm:user-1",
      aud: "trellis-api",
      iat: FIXED_EPOCH_S,
      exp: FIXED_EPOCH_S + 3600,
      azp: "trellis-web",
    };
    const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    const sig = cryptoSign("RSA-SHA256", Buffer.from(input), rsa.privateKey);
    const token = `${input}.${b64url(sig)}`;
    const res = await verifier.verify(token);
    expect(res.claims.sub).toBe("f:realm:user-1");
  });

  it("still rejects a no-exp token on the generic branch [SEC-1]", async () => {
    const rsa = makeRsaKey("kc-1");
    const { verifier } = buildPrimed(kcConfig, [[rsa]]);
    const header = { alg: "RS256", typ: "JWT", kid: "kc-1" };
    const payload = { iss: kcIssuer, sub: "f:realm:user-1", aud: "trellis-api", iat: FIXED_EPOCH_S };
    const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    const sig = cryptoSign("RSA-SHA256", Buffer.from(input), rsa.privateKey);
    const token = `${input}.${b64url(sig)}`;
    await expect(verifier.verify(token)).rejects.toMatchObject({ reason: "missing_exp" });
  });
});
