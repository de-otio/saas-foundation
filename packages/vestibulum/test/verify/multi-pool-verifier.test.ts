/**
 * Tests for the multi-pool JWT verifier.
 *
 * The verifier is security-critical: a bug here can make B2C tokens accepted
 * on B2B operations and vice versa. The test plan covers every
 * {@link MultiPoolVerifierError.reason} value, plus a substring-attack
 * regression test for the exact-issuer-match guarantee.
 *
 * Signature verification uses real RSA keys generated per-test so we
 * exercise `aws-jwt-verify`'s real crypto path; the JWKS cache is primed
 * via `cacheJwks` so we never hit the network.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { generateKeyPairSync, KeyObject, sign as cryptoSign } from "node:crypto";
import { CognitoJwtVerifier } from "aws-jwt-verify";

import {
  canonicalIssuer,
  createMultiPoolVerifier,
  type PoolConfig,
  requirePool,
  type VerifiedToken,
} from "../../src/verify/multi-pool-verifier.js";
import { MultiPoolVerifierError } from "../../src/errors.js";

/* ----------------------------------------------------------------- *
 * Fixed epoch for deterministic JWT timestamps                       *
 * (2030-01-01T00:00:00Z = 1893456000 Unix seconds)                  *
 * ----------------------------------------------------------------- */
const FIXED_EPOCH_S = 1893456000;
const FIXED_EPOCH_MS = FIXED_EPOCH_S * 1000;

/* ----------------------------------------------------------------- *
 * RSA key + JWK helpers                                              *
 * ----------------------------------------------------------------- */

function b64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface TestKeyMaterial {
  privateKey: KeyObject;
  publicKey: KeyObject;
  jwk: {
    kty: "RSA";
    use: "sig";
    alg: "RS256";
    kid: string;
    n: string;
    e: string;
  };
}

function makeKey(kid: string): TestKeyMaterial {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = publicKey.export({ format: "jwk" }) as {
    n: string;
    e: string;
  };
  return {
    privateKey,
    publicKey,
    jwk: {
      kty: "RSA",
      use: "sig",
      alg: "RS256",
      kid,
      n: jwk.n,
      e: jwk.e,
    },
  };
}

interface SignOptions {
  iss: string;
  clientId?: string;
  tokenUse?: "access" | "id";
  exp?: number;
  kid?: string;
  extraClaims?: Record<string, unknown>;
  alg?: string;
  signWith?: KeyObject;
}

function signJwt(key: TestKeyMaterial, opts: SignOptions): string {
  const header = {
    alg: opts.alg ?? "RS256",
    typ: "JWT",
    kid: opts.kid ?? key.jwk.kid,
  };
  const now = FIXED_EPOCH_S;
  const tokenUse = opts.tokenUse ?? "access";
  const payload: Record<string, unknown> = {
    iss: opts.iss,
    sub: "test-user",
    iat: now,
    exp: opts.exp ?? now + 3600,
    token_use: tokenUse,
    auth_time: now,
    jti: "test-jti",
    origin_jti: "test-origin-jti",
  };
  if (tokenUse === "access") {
    payload.client_id = opts.clientId ?? "test-client";
    payload.username = "test-user";
    payload.scope = "aws.cognito.signin.user.admin";
    payload.version = 2;
  } else {
    payload.aud = opts.clientId ?? "test-client";
    payload["cognito:username"] = "test-user";
  }
  Object.assign(payload, opts.extraClaims ?? {});

  const headerB64 = b64url(JSON.stringify(header));
  const payloadB64 = b64url(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;
  const signKey = opts.signWith ?? key.privateKey;
  const sig = cryptoSign("RSA-SHA256", Buffer.from(signingInput), signKey);
  return `${signingInput}.${b64url(sig)}`;
}

/* ----------------------------------------------------------------- *
 * Standard fixtures                                                  *
 * ----------------------------------------------------------------- */

const B2C_REGION = "us-east-1";
const B2C_POOL_ID = "us-east-1_aaaaaaaa";
const B2C_CLIENT = "client-b2c";

const B2B_REGION = "us-east-1";
const B2B_POOL_ID = "us-east-1_bbbbbbbb";
const B2B_CLIENT = "client-b2b";

function makeStandardPools(): PoolConfig[] {
  return [
    {
      poolKey: "b2c",
      userPoolId: B2C_POOL_ID,
      clientId: B2C_CLIENT,
      region: B2C_REGION,
      tokenUse: "access",
    },
    {
      poolKey: "b2b",
      userPoolId: B2B_POOL_ID,
      clientId: B2B_CLIENT,
      region: B2B_REGION,
      tokenUse: "access",
    },
  ];
}

/* ----------------------------------------------------------------- *
 * Verifier builder with primed JWKS                                  *
 * ----------------------------------------------------------------- */

function buildPrimedVerifier(pools: PoolConfig[], jwksByPool: Record<string, TestKeyMaterial[]>) {
  const original = CognitoJwtVerifier.create.bind(CognitoJwtVerifier);
  const spy = vi.spyOn(CognitoJwtVerifier, "create").mockImplementation((props: unknown) => {
    const cast = props as { userPoolId: string };
    const rawInst = original(props as Parameters<typeof original>[0]);
    const inst = rawInst as unknown as {
      cacheJwks: (jwks: unknown) => void;
    };
    const keys = jwksByPool[cast.userPoolId];
    if (keys) {
      inst.cacheJwks({ keys: keys.map((k) => k.jwk) });
    }
    return rawInst;
  });
  try {
    return createMultiPoolVerifier(pools);
  } finally {
    spy.mockRestore();
  }
}

/* ----------------------------------------------------------------- *
 * Tests                                                              *
 * All tests run with a fixed system time so JWT exp/iat assertions   *
 * are deterministic.                                                 *
 * ----------------------------------------------------------------- */

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_EPOCH_MS);
});

afterAll(() => {
  vi.useRealTimers();
});

describe("canonicalIssuer", () => {
  it("builds the documented exact URL", () => {
    expect(canonicalIssuer("us-east-1", "us-east-1_aaaaaaaa")).toBe(
      "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_aaaaaaaa",
    );
  });
});

describe("createMultiPoolVerifier", () => {
  it("throws synchronously on empty pool list", () => {
    expect(() => createMultiPoolVerifier([])).toThrow(/at least one PoolConfig/);
  });

  it("throws synchronously on duplicate issuer", () => {
    const dupes: PoolConfig[] = [
      {
        poolKey: "a",
        userPoolId: B2C_POOL_ID,
        clientId: B2C_CLIENT,
        region: B2C_REGION,
        tokenUse: "access",
      },
      {
        poolKey: "b",
        userPoolId: B2C_POOL_ID,
        clientId: B2C_CLIENT,
        region: B2C_REGION,
        tokenUse: "access",
      },
    ];
    expect(() => createMultiPoolVerifier(dupes)).toThrow(/duplicate pool/);
  });
});

describe("MultiPoolVerifier.verify", () => {
  it("returns the verified claims and poolKey for a B2C token", async () => {
    const b2cKey = makeKey("b2c-kid");
    const b2bKey = makeKey("b2b-kid");
    const verifier = buildPrimedVerifier(makeStandardPools(), {
      [B2C_POOL_ID]: [b2cKey],
      [B2B_POOL_ID]: [b2bKey],
    });

    const token = signJwt(b2cKey, {
      iss: canonicalIssuer(B2C_REGION, B2C_POOL_ID),
      clientId: B2C_CLIENT,
      tokenUse: "access",
    });

    const verified = await verifier.verify(token);
    expect(verified.poolKey).toBe("b2c");
    expect(verified.claims.sub).toBe("test-user");
    expect(verified.claims.iss).toBe(canonicalIssuer(B2C_REGION, B2C_POOL_ID));
    expect(verified.rawToken).toBe(token);
  });

  it('returns poolKey="b2b" for a B2B token', async () => {
    const b2cKey = makeKey("b2c-kid");
    const b2bKey = makeKey("b2b-kid");
    const verifier = buildPrimedVerifier(makeStandardPools(), {
      [B2C_POOL_ID]: [b2cKey],
      [B2B_POOL_ID]: [b2bKey],
    });

    const token = signJwt(b2bKey, {
      iss: canonicalIssuer(B2B_REGION, B2B_POOL_ID),
      clientId: B2B_CLIENT,
      tokenUse: "access",
    });

    const verified = await verifier.verify(token);
    expect(verified.poolKey).toBe("b2b");
  });

  describe("error reasons", () => {
    let b2cKey: TestKeyMaterial;
    let b2bKey: TestKeyMaterial;
    let verifier: ReturnType<typeof createMultiPoolVerifier>;

    beforeEach(() => {
      b2cKey = makeKey("b2c-kid");
      b2bKey = makeKey("b2b-kid");
      verifier = buildPrimedVerifier(makeStandardPools(), {
        [B2C_POOL_ID]: [b2cKey],
        [B2B_POOL_ID]: [b2bKey],
      });
    });

    it("rejects an empty string with malformed_token", async () => {
      await expect(verifier.verify("")).rejects.toMatchObject({
        reason: "malformed_token",
      });
    });

    it("rejects a non-string token with malformed_token", async () => {
      await expect(verifier.verify(null as unknown as string)).rejects.toMatchObject({
        reason: "malformed_token",
      });
    });

    it("rejects a syntactically broken JWT with malformed_token", async () => {
      await expect(verifier.verify("not-a-real-jwt")).rejects.toBeInstanceOf(
        MultiPoolVerifierError,
      );
      await expect(verifier.verify("not-a-real-jwt")).rejects.toMatchObject({
        reason: "malformed_token",
      });
    });

    it("rejects a token with an unknown issuer with unknown_issuer", async () => {
      const stranger = makeKey("stranger-kid");
      const token = signJwt(stranger, {
        iss: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_zzzzzzzz",
        clientId: B2C_CLIENT,
      });
      await expect(verifier.verify(token)).rejects.toMatchObject({
        reason: "unknown_issuer",
      });
    });

    it("rejects an expired token with expired", async () => {
      const token = signJwt(b2cKey, {
        iss: canonicalIssuer(B2C_REGION, B2C_POOL_ID),
        clientId: B2C_CLIENT,
        exp: FIXED_EPOCH_S - 60,
      });
      await expect(verifier.verify(token)).rejects.toMatchObject({
        reason: "expired",
      });
    });

    it("rejects a token with wrong client_id with wrong_client_id", async () => {
      const token = signJwt(b2cKey, {
        iss: canonicalIssuer(B2C_REGION, B2C_POOL_ID),
        clientId: "a-different-client",
      });
      await expect(verifier.verify(token)).rejects.toMatchObject({
        reason: "wrong_client_id",
      });
    });

    it("rejects a token with wrong token_use with wrong_token_use", async () => {
      const token = signJwt(b2cKey, {
        iss: canonicalIssuer(B2C_REGION, B2C_POOL_ID),
        clientId: B2C_CLIENT,
        tokenUse: "id",
      });
      await expect(verifier.verify(token)).rejects.toMatchObject({
        reason: "wrong_token_use",
      });
    });

    it("rejects a token signed with a different key with invalid_signature", async () => {
      const intruder = makeKey("b2c-kid");
      const token = signJwt(b2cKey, {
        iss: canonicalIssuer(B2C_REGION, B2C_POOL_ID),
        clientId: B2C_CLIENT,
        signWith: intruder.privateKey,
      });
      await expect(verifier.verify(token)).rejects.toMatchObject({
        reason: "invalid_signature",
      });
    });

    it("rejects a token with unsupported alg with invalid_signature", async () => {
      const token = signJwt(b2cKey, {
        iss: canonicalIssuer(B2C_REGION, B2C_POOL_ID),
        clientId: B2C_CLIENT,
        alg: "HS256",
      });
      await expect(verifier.verify(token)).rejects.toMatchObject({
        reason: "invalid_signature",
      });
    });

    it("rejects a token whose iss substring-matches a pool ID (substring attack)", async () => {
      const attacker = makeKey("attacker-kid");
      const token = signJwt(attacker, {
        iss: `https://attacker.example/${B2C_POOL_ID}/something`,
        clientId: B2C_CLIENT,
      });
      await expect(verifier.verify(token)).rejects.toMatchObject({
        reason: "unknown_issuer",
      });
    });

    it("rejects an iss with trailing slash (no trailing-slash tolerance)", async () => {
      const attacker = makeKey("attacker-kid");
      const token = signJwt(attacker, {
        iss: `${canonicalIssuer(B2C_REGION, B2C_POOL_ID)}/`,
        clientId: B2C_CLIENT,
      });
      await expect(verifier.verify(token)).rejects.toMatchObject({
        reason: "unknown_issuer",
      });
    });

    it("rejects an iss with mismatched case (no case-insensitive match)", async () => {
      const attacker = makeKey("attacker-kid");
      const token = signJwt(attacker, {
        iss: canonicalIssuer(B2C_REGION, B2C_POOL_ID).toUpperCase(),
        clientId: B2C_CLIENT,
      });
      await expect(verifier.verify(token)).rejects.toMatchObject({
        reason: "unknown_issuer",
      });
    });
  });

  it("errors are instances of MultiPoolVerifierError", async () => {
    const b2cKey = makeKey("b2c-kid");
    const b2bKey = makeKey("b2b-kid");
    const verifier = buildPrimedVerifier(makeStandardPools(), {
      [B2C_POOL_ID]: [b2cKey],
      [B2B_POOL_ID]: [b2bKey],
    });
    await expect(verifier.verify("")).rejects.toBeInstanceOf(MultiPoolVerifierError);
  });
});

describe("requirePool", () => {
  function makeVerified(poolKey: string): VerifiedToken {
    return {
      poolKey,
      claims: { sub: "test" },
      rawToken: "token",
    };
  }

  it("passes when poolKey matches the single expected value", () => {
    expect(() => requirePool(makeVerified("b2b"), "b2b")).not.toThrow();
  });

  it("passes when poolKey is in the expected array", () => {
    expect(() => requirePool(makeVerified("b2c"), ["b2b", "b2c"])).not.toThrow();
  });

  it("throws MultiPoolVerifierError(wrong_pool) on string mismatch", () => {
    expect(() => requirePool(makeVerified("b2c"), "b2b")).toThrow(MultiPoolVerifierError);
    try {
      requirePool(makeVerified("b2c"), "b2b");
    } catch (err) {
      expect(err).toBeInstanceOf(MultiPoolVerifierError);
      expect((err as MultiPoolVerifierError).reason).toBe("wrong_pool");
    }
  });

  it("throws on array mismatch", () => {
    expect(() => requirePool(makeVerified("b2c"), ["b2b", "internal"])).toThrow(
      MultiPoolVerifierError,
    );
  });

  it("throws on empty expected array", () => {
    expect(() => requirePool(makeVerified("b2c"), [])).toThrow(MultiPoolVerifierError);
  });
});

describe("error mapping (mapError fallthroughs)", () => {
  function buildStubVerifier(errToThrow: Error) {
    const original = CognitoJwtVerifier.create.bind(CognitoJwtVerifier);
    const spy = vi.spyOn(CognitoJwtVerifier, "create").mockImplementation((props: unknown) => {
      const rawInst = original(props as Parameters<typeof original>[0]);
      (rawInst as unknown as { verify: () => Promise<never> }).verify = () =>
        Promise.reject(errToThrow);
      return rawInst;
    });
    try {
      return createMultiPoolVerifier(makeStandardPools());
    } finally {
      spy.mockRestore();
    }
  }

  it("maps a generic JwtInvalidClaimError (audience mismatch) to malformed_token", async () => {
    // Build a token with a parseable B2C iss so it passes the iss lookup
    // stage and reaches the verifier
    const b2cKey = makeKey("b2c-kid-stub");
    const token = signJwt(b2cKey, {
      iss: canonicalIssuer(B2C_REGION, B2C_POOL_ID),
      clientId: B2C_CLIENT,
    });

    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const errors = require("aws-jwt-verify/error") as {
      JwtInvalidAudienceError: new (msg: string, actual: unknown, expected?: string) => Error;
    };
    const audErr = new errors.JwtInvalidAudienceError("aud mismatch", "actual-aud", "expected-aud");
    const verifier = buildStubVerifier(audErr);
    await expect(verifier.verify(token)).rejects.toMatchObject({
      reason: "malformed_token",
    });
  });

  it("maps a non-aws-jwt-verify error to malformed_token (final fallback)", async () => {
    const b2cKey = makeKey("b2c-kid-stub2");
    const token = signJwt(b2cKey, {
      iss: canonicalIssuer(B2C_REGION, B2C_POOL_ID),
      clientId: B2C_CLIENT,
    });

    const generic = new Error("some unexpected runtime failure");
    const verifier = buildStubVerifier(generic);
    await expect(verifier.verify(token)).rejects.toMatchObject({
      reason: "malformed_token",
    });
  });
});
