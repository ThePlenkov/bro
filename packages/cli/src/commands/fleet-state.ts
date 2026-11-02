/**
 * fleet-state — moved to @broject/herdr-kit's fleet module (the doc
 * contract + target resolution). This file stays a re-export shim so
 * the many cli call sites keep resolving on their old path.
 */
export {
  type FleetPaneState,
  fleetStatusDir,
  fleetStatusPath,
  type LedState,
  nextSeq,
  type PaneLed,
  parseFleetState,
  pruneFleetStatus,
  readFleetState,
  writeFleetState,
} from '@broject/herdr-kit';
