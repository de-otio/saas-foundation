/**
 * login-callback.js — magic-link sign-in completion (browser).
 *
 * The magic-link email points the user's browser at
 * `/login/callback#token=<token>`. This page:
 *   1. Reads the token from the URL *fragment* (never the query string), then
 *      scrubs it from history via `replaceState` so it isn't leaked. The token
 *      is held in memory only.
 *   2. Renders ONE button. Loading the page sends nothing: link scanners,
 *      previewers and browser prerendering can run page scripts — sometimes in
 *      the user's own profile — so redemption must wait for a real click
 *      (`signin_redeem_requires_user_gesture`). While `document.prerendering`
 *      is true the page does not even read the fragment.
 *   3. On click, POSTs `{ answer: token }` to `/auth-verify`. Nothing else is
 *      sent: the pending Cognito session is held server-side and bound to the
 *      browser that asked by the HttpOnly `__Host-signin` cookie, which the
 *      browser attaches itself. A link opened in a different browser therefore
 *      fails without consuming anything.
 *   4. On success, redirects to `/`.
 */

/** In-memory only; cleared as soon as it has been sent. */
let token = null;

const confirmEl = document.getElementById("confirm");
const spinnerEl = document.getElementById("spinner");
const messageEl = document.getElementById("message");
const buttonEl = document.getElementById("sign-in");

/** Show a message and a link back to /login; hide the button. */
function fail(message) {
  token = null;
  spinnerEl.hidden = true;
  confirmEl.hidden = true;
  messageEl.textContent = "";
  const p = document.createElement("p");
  p.textContent = message;
  const a = document.createElement("a");
  a.href = "/login";
  a.textContent = "Request a new sign-in link";
  messageEl.append(p, a);
}

/** Extract `token` from the URL fragment (`#token=...`). */
function readTokenFromFragment() {
  const hash = window.location.hash.replace(/^#/, "");
  return new URLSearchParams(hash).get("token");
}

/** Read the fragment, scrub it, and offer the button. Sends nothing. */
function prepare() {
  token = readTokenFromFragment();
  // Scrub the token from the address bar / history immediately.
  history.replaceState(null, "", window.location.pathname);

  if (token === null || token === "") {
    fail("This sign-in link is invalid or has expired.");
    return;
  }
  spinnerEl.hidden = true;
  confirmEl.hidden = false;
  buttonEl.focus();
}

/** Click handler: the only place a redemption request is ever sent. */
async function redeem() {
  const answer = token;
  if (answer === null) return;
  token = null;
  buttonEl.disabled = true;

  try {
    const body = JSON.stringify({ answer });
    // `/auth-verify` is a Lambda Function URL behind CloudFront OAC. AWS
    // requires POST clients to send the SHA-256 of the body in the
    // `x-amz-content-sha256` header (Lambda Function URLs reject unsigned
    // payloads); CloudFront then SigV4-signs the origin request itself. Without
    // this header the signed request fails with a 403 signature mismatch.
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
    const payloadHash = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const res = await fetch("/auth-verify", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "x-amz-content-sha256": payloadHash,
      },
      body,
    });
    if (!res.ok) {
      fail(
        "This sign-in link is invalid, has expired, or was opened in a different browser " +
          "than the one you asked from. Open it in that browser, or request a new link.",
      );
      return;
    }
    window.location.replace("/");
  } catch {
    fail("Something went wrong completing sign-in. Please request a new link.");
  }
}

buttonEl.addEventListener("click", () => {
  void redeem();
});

// A prerendered page is loaded without the user having navigated to it: wait
// until it is actually shown before touching the fragment.
if (document.prerendering === true) {
  document.addEventListener("prerenderingchange", prepare, { once: true });
} else {
  prepare();
}
