/**
 * login.js — magic-link sign-in initiation (browser).
 *
 * Flow:
 *   1. On submit, POST `{ email }` (JSON) to the same-origin `/auth-login`
 *      endpoint (a Lambda Function URL behind CloudFront OAC). The request
 *      carries `x-amz-content-sha256: <hex sha256 of body>` so that
 *      CloudFront can SigV4-sign the origin request; the browser automatically
 *      adds the `Origin` header for same-origin requests.
 *   2. The endpoint answers `202 {}` and sets an HttpOnly `__Host-signin`
 *      cookie. That cookie — not anything this script can read — is what binds
 *      the pending sign-in to THIS browser. The Cognito session stays on the
 *      server; nothing is kept in sessionStorage or localStorage.
 *   3. Show a generic "check your email" message, and a field for the 8-digit
 *      code from the mail. The code is the fallback for a link opened in
 *      another browser or on another device: it is typed HERE, in the browser
 *      that asked (the one holding the binding cookie), and sent as
 *      `{ answer: code }` to `/auth-verify` — only on an explicit submit, never
 *      automatically (`signin_redeem_requires_user_gesture`). On success the
 *      page goes to `/`, exactly as the callback page does.
 *
 * Enumeration parity: the endpoint returns the same 202 and a cookie whether or
 * not the address exists, is allowed, or is rate limited, and only after a
 * fixed minimum delay. So the success copy is identical for every address. On
 * failure the same generic error is shown — never distinguish failure modes.
 */

const form = document.getElementById("login-form");
const emailInput = document.getElementById("email");
const errorEl = document.getElementById("error-message");
const successEl = document.getElementById("success-message");
const submitButton = form.querySelector("button[type=submit]");
const codeForm = document.getElementById("code-form");
const codeInput = document.getElementById("code");
const codeButton = codeForm.querySelector("button[type=submit]");

/** Set the error line (shown via CSS `:not(:empty)`); clears success. */
function showError(message) {
  successEl.textContent = "";
  errorEl.textContent = message;
}

/** Set the success line; clears any error. */
function showSuccess(message) {
  errorEl.textContent = "";
  successEl.textContent = message;
}

/**
 * Returns the lowercase hex SHA-256 digest of a UTF-8 string.
 * Required by `/auth-login` (Lambda Function URL behind CloudFront OAC):
 * AWS needs `x-amz-content-sha256` so CloudFront can SigV4-sign the
 * forwarded origin request; without it the signature mismatches and the
 * request is rejected with a 403.
 */
async function sha256hex(str) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = emailInput.value.trim();
  if (email === "") {
    showError("Please enter your email address.");
    return;
  }

  submitButton.disabled = true;
  showSuccess(""); // clear any prior message
  errorEl.textContent = "";

  try {
    const body = JSON.stringify({ email });
    const hash = await sha256hex(body);
    const res = await fetch("/auth-login", {
      method: "POST",
      // Same-origin by default, spelled out: the response sets the binding cookie.
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "x-amz-content-sha256": hash,
      },
      body,
    });
    if (res.status !== 202) throw new Error(`auth-login ${res.status}`);
    showSuccess("Check your email for a sign-in link. Open it in this browser.");
    // Offer the typed-code fallback. Nothing is sent until the user submits it.
    codeInput.value = "";
    codeButton.disabled = false;
    codeForm.hidden = false;
  } catch {
    // Generic message — never distinguish failure modes (enumeration parity).
    showError("Something went wrong. Please try again.");
    submitButton.disabled = false;
  }
});

/**
 * Submit handler of the code form: the only place a code is ever sent. The
 * request is the same one the callback page sends for the link token, and is
 * answered the same way: success goes to `/`, anything else gets one generic
 * message (a wrong, spent or expired code and a missing cookie are not told
 * apart). Every answer ends the pending request (one answer per session), so
 * after a failure the user asks for a new link.
 */
codeForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (codeButton.disabled) return; // one answer per request: ignore a repeat submit
  // Be lenient about how the code was copied ("1234 5678", "1234-5678").
  const answer = codeInput.value.replace(/[\s-]/g, "");
  if (!/^[0-9]{8}$/.test(answer)) {
    showError("Enter the 8 digits from the email.");
    return;
  }

  codeButton.disabled = true;
  errorEl.textContent = "";

  try {
    const body = JSON.stringify({ answer });
    const hash = await sha256hex(body);
    const res = await fetch("/auth-verify", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "x-amz-content-sha256": hash,
      },
      body,
    });
    if (!res.ok) throw new Error(`auth-verify ${res.status}`);
    window.location.replace("/");
  } catch {
    codeInput.value = "";
    codeForm.hidden = true;
    submitButton.disabled = false;
    showError(
      "That code did not work. It may be wrong, already used or expired, or it was requested " +
        "in a different browser. Request a new sign-in link and try again.",
    );
  }
});
