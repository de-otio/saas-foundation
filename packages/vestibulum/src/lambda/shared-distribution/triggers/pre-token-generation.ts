/**
 * Shared-distribution `PreTokenGeneration` Cognito trigger.
 *
 * Injects `custom:tenant_id` into every token issued by the shared pool.
 * This claim is load-bearing: the edge's structural Host ↔ tenant_id check
 * depends on it being present in every token.
 *
 * Uses `wrapPreTokenHandler` for symmetry with the consumer-customisation
 * pattern (consumers who need additional claims replace this handler and
 * wrap their logic with `wrapPreTokenHandler`).
 *
 * No additional claims are injected by the default handler — just the
 * mandatory `custom:tenant_id`.
 */

import { wrapPreTokenHandler, type PreTokenEventLike } from '../shared/wrap-pre-token-handler.js';

export const handler = wrapPreTokenHandler((event: PreTokenEventLike) => {
  // `custom:tenant_id` is pre-injected by the wrapper from the ClientConfig row.
  // No additional claims needed for the default shared-distribution handler.
  return Promise.resolve(event);
});
