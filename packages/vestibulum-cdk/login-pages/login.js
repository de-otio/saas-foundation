/**
 * login.js — magic-link sign-in initiation (browser).
 *
 * Flow:
 *   1. On submit, POST `{ email }` (JSON) to the same-origin `/auth-login`
 *      endpoint (a Lambda Function URL behind CloudFront OAC). The request
 *      carries `x-amz-content-sha256: <hex sha256 of body>` so that
 *      CloudFront can SigV4-sign the origin request; the browser automatically
 *      adds the `Origin` header for same-origin requests.
 *   2. On success, the response JSON `{ session }` is stashed as
 *      `{ email, session }` in sessionStorage so the callback page (opened by
 *      the magic link in the SAME browser) can complete the challenge.
 *   3. Show a generic "check your email" message.
 *
 * Enumeration parity: the backend issues a session even for unknown or
 * denylisted emails, only sending mail to real recipients. So a successful
 * `/auth-login` call always shows the same success copy regardless of whether
 * the address exists. On failure the same generic error is shown — never
 * distinguish failure modes.
 */

// Shared sessionStorage key — read back by login-callback.js.
const STORAGE_KEY = "vestibulum.magicLink";

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
      headers: {
        "Content-Type": "application/json",
        "x-amz-content-sha256": hash,
      },
      body,
    });
    if (!res.ok) throw new Error(`auth-login ${res.status}`);
    const data = await res.json();
    if (typeof data.session !== "string" || data.session === "") {
      throw new Error("auth-login: missing session");
    }
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ email, session: data.session }));
    showSuccess("Check your email for a sign-in link. Open it in this browser.");
  } catch {
    // Generic message — never distinguish failure modes (enumeration parity).
    showError("Something went wrong. Please try again.");
    submitButton.disabled = false;
  }
});
