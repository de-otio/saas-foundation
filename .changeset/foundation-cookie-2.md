---
"@de-otio/saas-foundation": patch
---

Move the session-cookie helpers to `cookie` 2. `parseCookieHeader` now calls
`parseCookie` and `serializeSetCookie` calls `stringifySetCookie`, since
cookie 2 renamed its API. The exported signatures and the default attributes
(`HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`) are unchanged.

One observable difference in the emitted `Set-Cookie` header: cookie 2 no
longer percent-encodes characters that RFC 6265 allows in a cookie value, so
the base64 session envelope is written with literal `+`, `/` and `=` instead of
`%2B`, `%2F` and `%3D`. Both encodings parse to the same value with
`parseCookieHeader` (and with cookie 1), so cookies set before the upgrade still
unseal. A consumer that reads the raw header without percent-decoding now sees
the envelope as-is.
