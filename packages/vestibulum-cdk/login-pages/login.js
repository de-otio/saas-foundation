/**
 * login.js — magic-link sign-in initiation (browser).
 *
 * Flow:
 *   1. Load `/login-config.json` (deploy-injected: region + public website
 *      client id).
 *   2. On submit, call Cognito `InitiateAuth` (AuthFlow CUSTOM_AUTH) directly
 *      against the regional Cognito IDP endpoint. The website client is a
 *      public SPA client (no secret), so this is safe from the browser.
 *   3. Cognito returns a `Session`. Stash `{ email, session }` in
 *      sessionStorage so the callback page (opened by the magic link in the
 *      SAME browser) can complete the challenge.
 *   4. Show a generic "check your email" message.
 *
 * Enumeration parity: the backend issues a challenge (and a `Session`) even
 * for unknown or denylisted emails, only sending mail to real recipients. So
 * a successful `InitiateAuth` always shows the same success copy regardless of
 * whether the address exists.
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

let configPromise;
/** Fetch and cache `/login-config.json`. */
function loadConfig() {
  configPromise ??= fetch("/login-config.json", { credentials: "omit" }).then((res) => {
    if (!res.ok) throw new Error(`config ${res.status}`);
    return res.json();
  });
  return configPromise;
}

/**
 * Calls Cognito `InitiateAuth` (CUSTOM_AUTH) and returns the challenge Session.
 * Raw JSON-1.1 protocol call — avoids bundling the AWS SDK into a static asset.
 */
async function initiateAuth(region, clientId, email) {
  const res = await fetch(`https://cognito-idp.${region}.amazonaws.com/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
    },
    body: JSON.stringify({
      AuthFlow: "CUSTOM_AUTH",
      ClientId: clientId,
      AuthParameters: { USERNAME: email },
    }),
  });
  if (!res.ok) throw new Error(`InitiateAuth ${res.status}`);
  const data = await res.json();
  if (typeof data.Session !== "string" || data.Session === "") {
    throw new Error("InitiateAuth: missing Session");
  }
  return data.Session;
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
    const { region, userPoolClientId } = await loadConfig();
    const session = await initiateAuth(region, userPoolClientId, email);
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ email, session }));
    showSuccess("Check your email for a sign-in link. Open it in this browser.");
  } catch {
    // Generic message — never distinguish failure modes (enumeration parity).
    showError("Something went wrong. Please try again.");
    submitButton.disabled = false;
  }
});
