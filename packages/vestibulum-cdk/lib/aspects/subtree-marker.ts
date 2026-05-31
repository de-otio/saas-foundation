import { IConstruct } from "constructs";

/**
 * Construct-metadata `type` used to mark the root of a Vestibulum-owned
 * subtree (`MagicLinkIdentity`, `MagicLinkAuthSite`).
 *
 * Aspects walk up `node.scopes` looking for this marker so they are inert
 * when applied broadly (e.g. at App or Stack level) and only fire on
 * nodes that live inside a Vestibulum-managed subtree. This keeps the
 * Aspects safe to apply at any scope — consumers cannot accidentally
 * blow up unrelated stacks by adding `Aspects.of(app).add(...)`.
 */
export const VESTIBULUM_SUBTREE_MARKER_TYPE = "vestibulum:subtree-root";

/**
 * Marks a construct as the root of a Vestibulum subtree.
 *
 * `MagicLinkIdentity` and `MagicLinkAuthSite` MUST call this from their
 * constructor so that the synth-time Aspects can detect they are running
 * inside Vestibulum-owned configuration.
 */
export function markVestibulumSubtreeRoot(scope: IConstruct): void {
  scope.node.addMetadata(VESTIBULUM_SUBTREE_MARKER_TYPE, true, {
    stackTrace: false,
  });
}

/**
 * Returns `true` when `node` is inside (or is) a Vestibulum subtree root.
 *
 * Walks from `node` upward through every parent scope (inclusive). Cheap —
 * the deepest Vestibulum tree is fewer than ten levels.
 */
export function isInsideVestibulumSubtree(node: IConstruct): boolean {
  for (const scope of node.node.scopes) {
    for (const entry of scope.node.metadata) {
      if (entry.type === VESTIBULUM_SUBTREE_MARKER_TYPE) {
        return true;
      }
    }
  }
  return false;
}
