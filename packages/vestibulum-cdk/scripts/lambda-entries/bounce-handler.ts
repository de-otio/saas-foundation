/**
 * Bundle entry wrapper for the SES bounce/complaint handler.
 *
 * See `doc/vestibulum-cdk/10-lambda-bundle-pipeline.md`.
 */
import { createBounceHandler } from "@de-otio/vestibulum";

export const handler = createBounceHandler();
