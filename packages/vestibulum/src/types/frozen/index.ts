/**
 * Layer-0 barrel for the vestibulum-owned frozen types.
 *
 * Hand-curated — `export *` is forbidden so internal symbols cannot
 * graduate to public API by accident.
 */

export type {
  ClaimResolverInput,
  ClaimResolverOutput,
  ProvisionerInput,
  CallbackIdentity,
  KnownClaimTriggerSource,
  KnownProvisionerSource,
} from "./callbacks.js";

export { RESERVED_CLAIMS } from "./callbacks.js";
