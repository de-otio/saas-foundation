import * as cdk from "aws-cdk-lib";
import { describe, it, expect } from "vitest";
import {
  houseDashboard,
  listHouseDashboards,
  readHouseTemplate,
} from "../../lib/dashboards/index.js";
import { substitute } from "../../lib/dashboards/house-dashboard.js";
import type { VariableContract } from "../../lib/dashboards/contracts.js";

const TEST_ENV = { account: "123456789012", region: "eu-west-1" };

function makeStack(name: string): cdk.Stack {
  const app = new cdk.App();
  return new cdk.Stack(app, name, { env: TEST_ENV, stackName: name });
}

// Minimal valid contracts for unit testing the substitution engine
const SIMPLE_CONTRACT: VariableContract = {
  required: ["FOO"],
  optional: ["BAR"],
};

describe("substitute (unit)", () => {
  it("replaces required variable", () => {
    const body = '{"name":"${FOO}"}';
    const result = substitute(body, { FOO: "hello" }, SIMPLE_CONTRACT);
    expect(JSON.parse(result)).toEqual({ name: "hello" });
  });

  it("auto-escapes double quotes in values", () => {
    const body = '{"name":"${FOO}"}';
    const result = substitute(body, { FOO: 'say "hi"' }, SIMPLE_CONTRACT);
    // The value should be properly escaped so JSON.parse works
    const parsed = JSON.parse(result) as { name: string };
    expect(parsed.name).toBe('say "hi"');
  });

  it("auto-escapes backslashes in values", () => {
    const body = '{"path":"${FOO}"}';
    const result = substitute(body, { FOO: "C:\\Users\\foo" }, SIMPLE_CONTRACT);
    const parsed = JSON.parse(result) as { path: string };
    expect(parsed.path).toBe("C:\\Users\\foo");
  });

  it("auto-escapes control characters", () => {
    const body = '{"val":"${FOO}"}';
    const result = substitute(body, { FOO: "line1\nline2\ttab" }, SIMPLE_CONTRACT);
    const parsed = JSON.parse(result) as { val: string };
    expect(parsed.val).toBe("line1\nline2\ttab");
  });

  it("auto-escapes a value that looks like a template variable", () => {
    const body = '{"val":"${FOO}"}';
    // The replacement value itself contains ${...} — should be treated as literal string
    const result = substitute(body, { FOO: "${NOT_A_VARIABLE}" }, SIMPLE_CONTRACT);
    const parsed = JSON.parse(result) as { val: string };
    // The value is escaped so the ${ doesn't get re-interpreted
    expect(parsed.val).toBe("${NOT_A_VARIABLE}");
  });

  it("throws when a required variable is missing", () => {
    const body = '{"name":"${FOO}"}';
    expect(() => substitute(body, {}, SIMPLE_CONTRACT)).toThrow(
      /missing required variable\(s\): FOO/,
    );
  });

  it("removes the enclosing object when an optional variable is absent", () => {
    const body =
      '{"widgets":[{"title":"Required","val":"${FOO}"},{"title":"Optional","val":"${BAR}"}]}';
    const result = substitute(body, { FOO: "present" }, SIMPLE_CONTRACT);
    const parsed = JSON.parse(result) as { widgets: Array<{ title: string }> };
    expect(parsed.widgets).toHaveLength(1);
    expect(parsed.widgets[0]?.title).toBe("Required");
  });

  it("throws when unresolved placeholders remain after substitution", () => {
    const contractNoOptionals: VariableContract = { required: ["FOO"], optional: [] };
    const body = '{"a":"${FOO}","b":"${UNKNOWN}"}';
    expect(() => substitute(body, { FOO: "val" }, contractNoOptionals)).toThrow(
      /unresolved placeholder/,
    );
  });

  it("throws when output is not valid JSON", () => {
    // Construct a contract with a required var whose substitution breaks JSON
    // This is contrived but tests the parse guard
    const badContract: VariableContract = { required: ["FOO"], optional: [] };
    // We'd need the substituted template to be invalid JSON — hard to do with auto-escape.
    // Test the error path by passing a body that after substitution is not JSON.
    // Note: substitute() only validates JSON after all substitutions. A body with
    // extra text outside the JSON object would fail parse.
    const badBody = "not-json-${FOO}";
    expect(() => substitute(badBody, { FOO: "x" }, badContract)).toThrow(/not valid JSON/);
  });
});

describe("listHouseDashboards", () => {
  it("returns all three template names", () => {
    const names = listHouseDashboards();
    expect(names).toEqual(["api-health", "database", "workers"]);
  });
});

describe("readHouseTemplate — api-health", () => {
  const BASE_VARS = {
    REGION: "eu-west-1",
    LAMBDA_FUNCTION: "my-api-fn",
    ALB_ARN_SUFFIX: "app/my-alb/abc123",
  };

  it("renders without throwing when all required variables are supplied", () => {
    expect(() =>
      readHouseTemplate("api-health", { dashboardName: "d", variables: BASE_VARS }),
    ).not.toThrow();
  });

  it("returns valid JSON", () => {
    const body = readHouseTemplate("api-health", { dashboardName: "d", variables: BASE_VARS });
    expect(() => JSON.parse(body) as unknown).not.toThrow();
  });

  it("substitutes REGION into the output", () => {
    const body = readHouseTemplate("api-health", { dashboardName: "d", variables: BASE_VARS });
    expect(body).toContain('"eu-west-1"');
  });

  it("substitutes LAMBDA_FUNCTION into the output", () => {
    const body = readHouseTemplate("api-health", { dashboardName: "d", variables: BASE_VARS });
    expect(body).toContain("my-api-fn");
  });

  it("throws when a required variable is missing", () => {
    const { LAMBDA_FUNCTION: _lf, ...withoutLambda } = BASE_VARS;
    expect(() =>
      readHouseTemplate("api-health", { dashboardName: "d", variables: withoutLambda }),
    ).toThrow(/missing required variable/);
  });

  it("respects the region param as fallback for REGION", () => {
    const { REGION: _r, ...withoutRegion } = BASE_VARS;
    const body = readHouseTemplate("api-health", {
      dashboardName: "d",
      variables: withoutRegion,
      region: "us-east-1",
    });
    expect(body).toContain("us-east-1");
  });
});

describe("readHouseTemplate — database", () => {
  const BASE_VARS = {
    REGION: "eu-west-1",
    TABLE_NAME: "my-table",
    GSI1_NAME: "gsi1",
  };

  it("renders with all variables including optional GSI1_NAME", () => {
    const body = readHouseTemplate("database", { dashboardName: "d", variables: BASE_VARS });
    expect(() => JSON.parse(body) as unknown).not.toThrow();
    expect(body).toContain("my-table");
    expect(body).toContain("gsi1");
  });

  it("renders without optional GSI1_NAME and produces valid JSON", () => {
    const { GSI1_NAME: _g, ...withoutGsi } = BASE_VARS;
    const body = readHouseTemplate("database", { dashboardName: "d", variables: withoutGsi });
    expect(() => JSON.parse(body) as unknown).not.toThrow();
    expect(body).not.toContain("gsi1");
  });

  it("throws when TABLE_NAME is missing", () => {
    expect(() =>
      readHouseTemplate("database", { dashboardName: "d", variables: { REGION: "eu-west-1" } }),
    ).toThrow(/missing required variable/);
  });
});

describe("readHouseTemplate — workers", () => {
  const BASE_VARS = {
    REGION: "eu-west-1",
    LAMBDA_FUNCTION: "worker-fn",
    QUEUE_NAME: "my-queue",
    DLQ_NAME: "my-queue-dlq",
  };

  it("renders with all variables", () => {
    const body = readHouseTemplate("workers", { dashboardName: "d", variables: BASE_VARS });
    expect(() => JSON.parse(body) as unknown).not.toThrow();
    expect(body).toContain("worker-fn");
    expect(body).toContain("my-queue");
    expect(body).toContain("my-queue-dlq");
  });

  it("renders without optional DLQ_NAME and produces valid JSON", () => {
    const { DLQ_NAME: _d, ...withoutDlq } = BASE_VARS;
    const body = readHouseTemplate("workers", { dashboardName: "d", variables: withoutDlq });
    expect(() => JSON.parse(body) as unknown).not.toThrow();
    expect(body).not.toContain("my-queue-dlq");
  });

  it("throws when QUEUE_NAME is missing", () => {
    expect(() =>
      readHouseTemplate("workers", {
        dashboardName: "d",
        variables: { REGION: "eu-west-1", LAMBDA_FUNCTION: "fn" },
      }),
    ).toThrow(/missing required variable/);
  });
});

describe("houseDashboard (CDK construct)", () => {
  it("creates a CfnDashboard with the given name", () => {
    const stack = makeStack("DashboardStack");
    const dashboard = houseDashboard(stack, "ApiHealth", "api-health", {
      dashboardName: "my-api-health",
      variables: {
        REGION: "eu-west-1",
        LAMBDA_FUNCTION: "api-fn",
        ALB_ARN_SUFFIX: "app/my-alb/xyz",
      },
    });
    expect(dashboard).toBeDefined();
    expect(dashboard.dashboardName).toBe("my-api-health");
  });
});

describe("JSON-string escape: property-based style", () => {
  const PROP_CONTRACT: VariableContract = { required: ["VAL"], optional: [] };

  const tricky: string[] = [
    "",
    "simple",
    'with "quotes"',
    "with\\backslash",
    "with\nnewline",
    "with\ttab",
    "with null",
    "withcontrol",
    "unicode ☃ snowman",
    "${still-a-placeholder}",
    "nested ${VAR}",
    '{"json": "inside"}',
    '\\"escaped quote',
    "\\/forward-slash",
  ];

  for (const value of tricky) {
    it(`safely substitutes value: ${JSON.stringify(value)}`, () => {
      const body = '{"result":"${VAL}"}';
      const result = substitute(body, { VAL: value }, PROP_CONTRACT);
      const parsed = JSON.parse(result) as { result: string };
      expect(parsed.result).toBe(value);
    });
  }
});
