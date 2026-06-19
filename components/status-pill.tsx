export type TrackingStatus =
  | "not_yet_scanned"
  | "in_transit"
  | "out_for_delivery"
  | "delivered"
  | "exception";

function statusLabel(status: TrackingStatus) {
  return status.replaceAll("_", " ");
}

export function StatusPill({ status }: { status: TrackingStatus }) {
  return <span className={`status ${status}`}>{statusLabel(status)}</span>;
}
