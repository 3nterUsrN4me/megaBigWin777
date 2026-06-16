import type { WebSocket } from "ws";

// Interval configurable via env: WS_HEARTBEAT_TIMEOUT_MS (default 60 000 ms = 60 s)
// Check loop runs at 1/4 of the timeout to catch stale connections promptly.
const TIMEOUT_MS = parseInt(process.env["WS_HEARTBEAT_TIMEOUT_MS"] ?? "60000", 10);
const CHECK_INTERVAL_MS = Math.max(TIMEOUT_MS / 4, 5000);

/**
 * Tracks client heartbeat (PING) timestamps.
 *
 * Per ARCHITECTURE.md §7:
 *  - Client sends JSON PING every 30 s.
 *  - Server responds with PONG.
 *  - If no PING received for 60 s → server closes the WebSocket (1001 Going Away).
 */
export class HeartbeatManager {
  /** sessionId → timestamp of last received PING */
  private readonly lastPingAt = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;

  /**
   * Starts the background sweep timer.
   * `onTimeout` is called with the sessionId of each stale connection.
   */
  start(onTimeout: (sessionId: string) => void): void {
    if (this.timer !== null) return; // idempotent

    this.timer = setInterval(() => {
      const cutoff = Date.now() - TIMEOUT_MS;
      for (const [sessionId, ts] of this.lastPingAt) {
        if (ts < cutoff) {
          this.lastPingAt.delete(sessionId);
          onTimeout(sessionId);
        }
      }
    }, CHECK_INTERVAL_MS);

    // Don't keep the process alive just for the heartbeat check
    if (typeof this.timer === "object" && this.timer !== null && "unref" in this.timer) {
      (this.timer as NodeJS.Timeout).unref();
    }
  }

  /** Registers a new connection. */
  register(sessionId: string): void {
    this.lastPingAt.set(sessionId, Date.now());
  }

  /** Refreshes the timestamp for a connection that sent a PING. */
  ping(sessionId: string): void {
    this.lastPingAt.set(sessionId, Date.now());
  }

  /** Removes a disconnected client from tracking. */
  unregister(sessionId: string): void {
    this.lastPingAt.delete(sessionId);
  }

  /** Stops the sweep timer (call on server shutdown). */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
