import type { HouseDashboardName } from "./types.js";

/**
 * Variable contract for a single dashboard template.
 *
 * required: every variable listed here must be supplied; missing one throws at synth.
 * optional: if absent, the smallest enclosing JSON object (widget) containing
 *           the placeholder is removed from the template output.
 */
export interface VariableContract {
  readonly required: ReadonlyArray<string>;
  readonly optional: ReadonlyArray<string>;
}

/**
 * Contracts for all shipped house dashboard templates.
 *
 * api-health: REGION (required), LAMBDA_FUNCTION (required), ALB_ARN_SUFFIX (required)
 *   — all ALB widgets use ALB_ARN_SUFFIX; all Lambda widgets use LAMBDA_FUNCTION.
 *
 * database: REGION (required), TABLE_NAME (required), GSI1_NAME (optional)
 *   — GSI1_NAME omission drops the GSI1 metric rows in read/write capacity widgets.
 *
 * workers: REGION (required), LAMBDA_FUNCTION (required), QUEUE_NAME (required),
 *          DLQ_NAME (optional)
 *   — DLQ_NAME omission drops the DLQ Depth widget.
 */
export const TEMPLATE_CONTRACTS: Readonly<Record<HouseDashboardName, VariableContract>> = {
  "api-health": {
    required: ["REGION", "LAMBDA_FUNCTION", "ALB_ARN_SUFFIX"],
    optional: [],
  },
  database: {
    required: ["REGION", "TABLE_NAME"],
    optional: ["GSI1_NAME"],
  },
  workers: {
    required: ["REGION", "LAMBDA_FUNCTION", "QUEUE_NAME"],
    optional: ["DLQ_NAME"],
  },
};
