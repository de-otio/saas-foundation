/**
 * login-callback.js — magic-link sign-in completion (browser).
 *
 * The magic-link email points the user's browser at
 * `/login/callback#token=<token>`. This page:
 *   1. Reads the token from the URL *fragment* (never the query string), then
 *      scrubs it from history via `replaceState` so it isn't leaked.
 *   2. Reads the `{ email, session }` stashed by login.js in sessionStorage
 *      (the link must be opened in the same browser that started sign-in).
 *   3. POSTs `{ session, challengeAnswer: token, email }` to `/auth-verify`,
 *      which calls Cognito `RespondToAuthChallenge` and sets the HttpOnly
 *      auth cookies. `credentials: "include"` so the cookies stick; the
 *      browser's same-origin `Origin` header satisfies auth-verify's CSRF
 *      check.
 *   4. On success, redirects to `/`.
 */

const STORAGE_KEY = "vestibulum.magicLink";

/** Replace the spinner with an error message + a link back to /login. */
function fail(message) {
  document.body.innerHTML = "";
  const p = document.createElement("p");
  p.textContent = message;
  const a = document.createElement("a");
  a.href = "/login";
  a.textContent = "Return to sign in";
  document.body.append(p, a);
}

/** Extract `token` from the URL fragment (`#token=...`). */
function readTokenFromFragment() {
  const hash = window.location.hash.replace(/^#/, "");
  return new URLSearchParams(hash).get("token");
}

async function complete() {
  const token = readTokenFromFragment();
  // Scrub the token from the address bar / history immediately.
  history.replaceState(null, "", window.location.pathname);

  if (token === null || token === "") {
    fail("This sign-in link is invalid or has expired.");
    return;
  }

  let stored;
  try {
    stored = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "null");
  } catch {
    stored = null;
  }
  if (stored === null || typeof stored.email !== "string" || typeof stored.session !== "string") {
    fail("Please open this link in the same browser you started sign-in from.");
    return;
  }

  try {
    const res = await fetch("/auth-verify", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session: stored.session,
        challengeAnswer: token,
        email: stored.email,
      }),
    });
    if (!res.ok) {
      fail("This sign-in link is invalid or has expired.");
      return;
    }
    sessionStorage.removeItem(STORAGE_KEY);
    window.location.replace("/");
  } catch {
    fail("Something went wrong completing sign-in. Please try again.");
  }
}

complete();
