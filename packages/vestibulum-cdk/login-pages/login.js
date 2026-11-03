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
 *   3. Show a generic "check your email" message.
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
  } catch {
    // Generic message — never distinguish failure modes (enumeration parity).
    showError("Something went wrong. Please try again.");
    submitButton.disabled = false;
  }
});
