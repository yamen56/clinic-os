/**
 * The Clinicti Bridge release this server hands out. The Bridge reports its
 * own version in every heartbeat; Settings → Devices says "update available"
 * when it is older than this. Bump it with every rebuild of the installer.
 */
export const BRIDGE_VERSION = "1.2.0";

/** Where the installer lives in storage — see scripts/publish-bridge.ts. */
export const BRIDGE_STORAGE_PATH = "_system/bridge/ClinictiBridge.exe";
