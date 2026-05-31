/**
 * Reserved for future SCIM 2.0 implementation. v0.x ships no SCIM
 * exports.
 *
 * The `scim/` subdirectory is staked out so the naming and
 * structural placement are decided before implementation. See
 * doc/vestibulum/07-scim-forward-compat.md for the full design
 * sketch (HTTP handler factory, bearer-token authentication,
 * account-linking on first federated login after SCIM provision,
 * deactivation triggers, tenant-scoped endpoint URL).
 *
 * Nothing in vestibulum's own source imports from `./scim/`. The
 * directory exists as a reserved namespace; consumers MUST NOT
 * rely on any specific shape here until v1.x lands SCIM support.
 */

export {};
