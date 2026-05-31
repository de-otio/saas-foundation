import type { IConstruct } from "constructs";

/**
 * Metadata key used by house wrapper constructs to mark resources they own.
 * The Aspect checks for the absence of this key to detect raw resource usage.
 */
export const HOUSE_CONSTRUCT_METADATA_KEY = "de-otio:houseConstruct";

/**
 * Returns the house-construct tag value attached to the given construct node,
 * or undefined if the node was not created by a house wrapper construct.
 */
export function getHouseConstructTag(node: IConstruct): string | undefined {
  const entry = node.node.metadata.find((m) => m.type === HOUSE_CONSTRUCT_METADATA_KEY);
  return entry !== undefined ? String(entry.data) : undefined;
}
