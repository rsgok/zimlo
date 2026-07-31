// Single source of truth for the CLI/Bridge version pair. /healthz, the
// bridge_info socket handshake, `zimlo --version` and the service descriptor
// all read these constants so they can never drift apart.
export const ZIMLO_VERSION = "0.2.0";
export const ZIMLO_PROTOCOL_VERSION = 2;
