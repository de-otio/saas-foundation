/**
 * Named house dashboard templates shipped with this package.
 */
export type HouseDashboardName = "api-health" | "database" | "workers";

/**
 * Parameters for creating or rendering a house dashboard.
 */
export interface HouseDashboardParams {
  /**
   * Dashboard name in CloudWatch. Globally unique per account/region.
   */
  readonly dashboardName: string;

  /**
   * Variable substitutions. Each template declares its own contract;
   * passing an unknown variable throws at synth time.
   * See the per-template contracts in contracts.ts.
   */
  readonly variables: Readonly<Record<string, string>>;

  /**
   * AWS region for metric references.
   * If provided and REGION is not already in variables, it is merged in
   * as the REGION substitution variable.
   */
  readonly region?: string;
}
