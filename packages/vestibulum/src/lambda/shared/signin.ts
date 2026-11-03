/**
 * Shared constants and pure helpers for the mailed-link sign-in flow.
 *
 * Invariant names (`signin_*`) follow dot-notes
 * `doc/topics/passwordless-sign-in-aws/02-spec.md`; tests and code comments use
 * them verbatim.
 */

import { createHash, randomBytes, randomInt } from "crypto";

/**
 * DynamoDB attribute that holds a row's expiry (epoch seconds) on the token,
 * rate-limit and binding tables. The constructs set `timeToLiveAttribute` to
 * this same name; an agreement test in vestibulum-cdk keeps the two in step.
 * The TTL is cleanup only — handlers MUST still compare it with the clock
 * (`signin_link_expires_10min`).
 */
export const TTL_ATTRIBUTE = "expires_at";

/** Browser-binding cookie (`signin_link_bound_to_requesting_browser`). */
export const BINDING_COOKIE_NAME = "__Host-signin";

/** Link and Cognito `AuthSessionValidity` bounds, in minutes. */
export const MIN_TOKEN_TTL_MINUTES = 3;
export const MAX_TOKEN_TTL_MINUTES = 15;
export const DEFAULT_TOKEN_TTL_MINUTES = 10;

/**
 * `auth-login` response floor (`signin_request_indistinguishable`).
 *
 * Measured live (eu-central-1, warm, n=20 per caller class): the eligible path
 * (SignUp + InitiateAuth -> Define -> Create with its SES send) took longer than
 * 1500 ms in a third of requests (max ~1.7 s of handler time), while unknown and
 * rate-limited callers stayed on the floor — a tail only the eligible class had,
 * i.e. a statistical timing oracle. The floor must exceed the eligible path's
 * p99, so it is 2500 ms. Re-measure per stage (cold starts, SES latency).
 */
export const DEFAULT_SIGNIN_FLOOR_MS = 2500;

/** CreateAuthChallenge response floor, so direct Cognito callers see flat latency. */
export const DEFAULT_CREATE_FLOOR_MS = 400;

/** The token is 43 base64url characters; anything much longer is not an answer. */
export const MAX_ANSWER_LENGTH = 64;

/** Enrolment modes (`signin_no_self_signup`). */
export type Enrollment = "admin-only" | "self-signup";

/**
 * Parses `VESTIBULUM_ENROLLMENT`. Unset or empty is the safe default,
 * `admin-only`; any value that is not one of the two modes is `undefined` so a
 * caller fails closed rather than guess (a typo must not open self-signup, and
 * must not silently lock everyone out either).
 */
export function parseEnrollment(raw: string | undefined): Enrollment | undefined {
  if (raw === undefined || raw === "") return "admin-only";
  return raw === "admin-only" || raw === "self-signup" ? raw : undefined;
}

/** Cognito's own default refresh-token validity: 30 days, in seconds. */
export const DEFAULT_REFRESH_TOKEN_VALIDITY_SECONDS = 30 * 24 * 60 * 60;

/**
 * Parses `VESTIBULUM_REFRESH_TOKEN_VALIDITY_SECONDS`. Unset or empty is the
 * 30-day default; anything that is not a positive integer is `undefined`, so
 * the caller fails closed rather than widen a window (auth-signout's expired-ID-
 * token window) or a cookie lifetime (auth-verify's ID-token cookie).
 */
export function parseRefreshTokenValiditySeconds(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return DEFAULT_REFRESH_TOKEN_VALIDITY_SECONDS;
  if (!/^\d+$/.test(raw)) return undefined;
  const n = Number.parseInt(raw, 10);
  return n > 0 ? n : undefined;
}

/** A link token: 32 random bytes, base64url, 43 characters. */
const TOKEN_ANSWER = /^[A-Za-z0-9_-]{43}$/;
/** The typed fallback code: exactly 8 ASCII digits. */
const CODE_ANSWER = /^[0-9]{8}$/;

/** Which of the two accepted answer forms a string is, or `undefined` for neither. */
export type AnswerForm = "token" | "code";

/** Classifies an answer (`signin_answer_compare_constant_time`). Never throws. */
export function classifyAnswer(answer: unknown): AnswerForm | undefined {
  if (typeof answer !== "string") return undefined;
  if (TOKEN_ANSWER.test(answer)) return "token";
  if (CODE_ANSWER.test(answer)) return "code";
  return undefined;
}

/**
 * An 8-digit code drawn uniformly from [0, 10^8) and zero-padded. `randomInt`
 * uses rejection sampling, so there is no modulo bias. 10^8 values, one answer
 * per session and 20 sessions per address per day bound guessing at about
 * 7·10⁻⁵ a year per address (`signin_attempts_bounded`).
 */
export function newSigninCode(): string {
  return randomInt(0, 100_000_000).toString().padStart(8, "0");
}

/** SHA-256 of a UTF-8 string, hex-encoded. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Parses a token TTL. Returns `undefined` when the value is not an integer in
 * [3, 15], so callers can fail closed rather than run with a bad lifetime.
 */
export function parseTokenTtlMinutes(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return DEFAULT_TOKEN_TTL_MINUTES;
  if (!/^\d+$/.test(raw)) return undefined;
  const n = Number.parseInt(raw, 10);
  return n >= MIN_TOKEN_TTL_MINUTES && n <= MAX_TOKEN_TTL_MINUTES ? n : undefined;
}

/** Parses a non-negative millisecond env value, falling back to `fallback`. */
export function parseMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined || !/^\d+$/.test(raw)) return fallback;
  return Number.parseInt(raw, 10);
}

/** A fresh 256-bit binding secret `b`. Held by the browser only as a cookie. */
export function newBindingSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** `H(b)` — the binding row's key. The secret itself is never stored. */
export function hashBindingSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/**
 * `Set-Cookie` for the binding cookie. `__Host-` forbids a `Domain` attribute
 * and requires `Secure` and `Path=/`, so this cannot reuse `buildSetCookie`.
 */
export function buildBindingCookie(secret: string, maxAgeSeconds: number): string {
  return [
    `${BINDING_COOKIE_NAME}=${secret}`,
    `Max-Age=${maxAgeSeconds}`,
    "Path=/",
    "SameSite=Strict",
    "HttpOnly",
    "Secure",
  ].join("; ");
}

/** Clears the binding cookie. Same attributes as the cookie it replaces. */
export function clearBindingCookie(): string {
  return buildBindingCookie("", 0);
}

/**
 * Reads one cookie from a Lambda Function URL event.
 *
 * Payload format 2.0 delivers cookies in the `cookies` array and may drop the
 * `cookie` header, so both are consulted. Returns `undefined` when absent or
 * empty.
 */
export function readCookie(
  event: {
    readonly headers?: Record<string, string | undefined>;
    readonly cookies?: readonly string[];
  },
  name: string,
): string | undefined {
  const pairs: string[] = [...(event.cookies ?? [])];
  const header = event.headers?.["cookie"];
  if (header !== undefined && header !== "") {
    pairs.push(...header.split(";"));
  }
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() !== name) continue;
    const value = pair.slice(eq + 1).trim();
    return value === "" ? undefined : value;
  }
  return undefined;
}

/** Real timer sleep; replaced in tests. */
export function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `fn` and does not return (or rethrow) until at least `floorMs` have
 * passed since the start — on every path, including a thrown error. This keeps
 * response time independent of which branch ran.
 */
export async function withFloor<T>(
  floorMs: number,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
  fn: () => Promise<T>,
): Promise<T> {
  const start = now();
  try {
    return await fn();
  } finally {
    const remaining = floorMs - (now() - start);
    if (remaining > 0) await sleep(remaining);
  }
}

/**
 * Emits one CloudWatch EMF metric. Dimensions are closed enums only; never pass
 * an address, subject, IP, token or session (`signin_secrets_never_logged`).
 */
export function emitSigninMetric(
  metricName: string,
  dimensions: Readonly<Record<string, string>>,
): void {
  const namespace = process.env["VESTIBULUM_METRICS_NAMESPACE"] ?? "Vestibulum/Identity";
  process.stdout.write(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: namespace,
            Dimensions: [Object.keys(dimensions)],
            Metrics: [{ Name: metricName, Unit: "Count" }],
          },
        ],
      },
      ...dimensions,
      [metricName]: 1,
    }) + "\n",
  );
}
