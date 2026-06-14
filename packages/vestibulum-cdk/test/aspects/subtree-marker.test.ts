import { describe, it, expect } from "vitest";
import { App, Stack } from "aws-cdk-lib";
import { Construct } from "constructs";
import {
  VESTIBULUM_SUBTREE_MARKER_TYPE,
  markVestibulumSubtreeRoot,
  isInsideVestibulumSubtree,
} from "../../lib/aspects/subtree-marker.js";

describe("subtree-marker", () => {
  it("VESTIBULUM_SUBTREE_MARKER_TYPE is the expected string", () => {
    expect(VESTIBULUM_SUBTREE_MARKER_TYPE).toBe("vestibulum:subtree-root");
  });

  describe("isInsideVestibulumSubtree", () => {
    it("returns false for an unmarked construct", () => {
      const app = new App();
      const stack = new Stack(app, "Stack", {
        env: { account: "123456789012", region: "eu-west-1" },
      });
      const child = new Construct(stack, "Child");
      expect(isInsideVestibulumSubtree(child)).toBe(false);
    });

    it("returns true for a marked construct", () => {
      const app = new App();
      const stack = new Stack(app, "Stack", {
        env: { account: "123456789012", region: "eu-west-1" },
      });
      const root = new Construct(stack, "Root");
      markVestibulumSubtreeRoot(root);
      expect(isInsideVestibulumSubtree(root)).toBe(true);
    });

    it("returns true for a child of a marked construct", () => {
      const app = new App();
      const stack = new Stack(app, "Stack", {
        env: { account: "123456789012", region: "eu-west-1" },
      });
      const root = new Construct(stack, "Root");
      markVestibulumSubtreeRoot(root);
      const child = new Construct(root, "Child");
      const grandchild = new Construct(child, "Grandchild");
      expect(isInsideVestibulumSubtree(child)).toBe(true);
      expect(isInsideVestibulumSubtree(grandchild)).toBe(true);
    });

    it("returns false for a sibling of a marked construct", () => {
      const app = new App();
      const stack = new Stack(app, "Stack", {
        env: { account: "123456789012", region: "eu-west-1" },
      });
      const root = new Construct(stack, "Root");
      markVestibulumSubtreeRoot(root);
      const sibling = new Construct(stack, "Sibling");
      expect(isInsideVestibulumSubtree(sibling)).toBe(false);
    });
  });
});
