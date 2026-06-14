// Constructs
export { NodejsLambda, NodejsLambdaPropsError } from "./nodejs-lambda/index.js";
export type {
  NodejsLambdaProps,
  PrismaBundlingOptions,
  PrismaEngine,
  IteratorAgeAlarmOptions,
} from "./nodejs-lambda/index.js";

export { QueueWithDlq } from "./queue-with-dlq/index.js";
export type { QueueWithDlqProps } from "./queue-with-dlq/index.js";

export { SingleTable } from "./single-table/index.js";
export type { SingleTableProps } from "./single-table/index.js";

// Dashboards (substitution helper + house templates by name)
export { houseDashboard, listHouseDashboards, readHouseTemplate } from "./dashboards/index.js";
export type { HouseDashboardName, HouseDashboardParams } from "./dashboards/index.js";

// Aspects (compliance enforcement)
export { HouseDefaultsAspect } from "./aspects/index.js";
export type { HouseDefaultsAspectProps } from "./aspects/index.js";
export { HouseTaggingAspect, validateHouseTaggingApplied } from "./aspects/index.js";
export type { HouseTaggingAspectProps } from "./aspects/index.js";
