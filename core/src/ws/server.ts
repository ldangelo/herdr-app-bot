/**
 * The app API over a loopback WebSocket: how a herdr-app mod (which has `WebSocket` but no unix sockets
 * and no Node) talks to the host. A thin adapter over `AppApiServer`, the same `call`/`subscribe` seam the
 * desktop app's IPC uses.
 *
 * Protocol, one JSON object per text message:
 *   client -> server   {"op":"auth","token":"..."}                      must be first, within `authTimeoutMs`
 *   server -> client   {"op":"ready"}                                   events follow
 *   client -> server   {"id":1,"method":"chat.list","params":{}}
 *   server -> client   {"id":1,"result":...}  |  {"id":1,"error":{"code":"...","message":"..."}}
 *   server -> client   {"op":"event","event":{"seq":N,"type":"...","payload":...}}
 *
 * The token travels in the first message because a mod's WebSocket refuses credential headers. Anything
 * that can reach 127.0.0.1 can open the socket, so the token is the gate: it is random per start, only in a
 * 0600 file, and compared in constant time. Connections that send an `Origin` header (browsers) are refused.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { AppApiServer } from "../app-api/server.ts";
import { isAppApiError } from "../app-api/errors.ts";
import { log } from "../log.ts";

export const DEFAULT_AUTH_TIMEOUT_MS = 5_000;
export const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;
/** A client that lets this much pile up unread is gone or stuck; drop it rather than buffer without bound. */
export const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

export interface WsServerOptions {
  readonly api: AppApiServer;
  /** Defaults to a fresh random token. */
  readonly token?: string;
  /** 0 (default) picks a free port. */
  readonly port?: number;
  readonly authTimeoutMs?: number;
  readonly maxMessageBytes?: number;
  /** Called with the number of authenticated clients whenever it changes. */
  readonly onClientCount?: (count: number) => void;
}

export interface WsServer {
  readonly port: number;
  readonly token: string;
  /** Authenticated clients right now. */
  clientCount(): number;
  close(): Promise<void>;
}

function tokensMatch(expected: string, given: unknown): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function startAppApiWsServer(options: WsServerOptions): Promise<WsServer> {
  const token = options.token ?? randomBytes(24).toString("base64url");
  const authTimeoutMs = options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
  const http = createServer((_request, response) => {
    response.writeHead(404).end();
  });
  const sockets = new WebSocketServer({
    server: http,
    maxPayload: options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES,
    // A page in a browser always sends Origin; a mod does not. Refuse the former.
    verifyClient: (info: { origin?: string }) => info.origin === undefined || info.origin === "",
  });
  const authenticated = new Set<WebSocket>();
  const announce = (): void => options.onClientCount?.(authenticated.size);

  sockets.on("connection", (socket) => {
    let unsubscribe: (() => void) | null = null;
    const authTimer = setTimeout(() => socket.close(4401, "auth timeout"), authTimeoutMs);
    authTimer.unref();

    const send = (message: unknown): void => {
      if (socket.readyState !== socket.OPEN) return;
      if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
        socket.close(1013, "client too slow");
        return;
      }
      socket.send(JSON.stringify(message));
    };

    socket.on("message", (data, isBinary) => {
      if (isBinary) return void socket.close(1003, "text only");
      let message: unknown;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return void socket.close(1003, "invalid json");
      }
      if (!isRecord(message)) return void socket.close(1003, "invalid message");

      if (!authenticated.has(socket)) {
        if (message.op !== "auth" || !tokensMatch(token, message.token)) return void socket.close(4401, "bad token");
        clearTimeout(authTimer);
        authenticated.add(socket);
        unsubscribe = options.api.subscribe((event) => send({ op: "event", event }));
        send({ op: "ready" });
        announce();
        return;
      }

      const { id, method, params } = message;
      if ((typeof id !== "number" && typeof id !== "string") || typeof method !== "string") return void send({ error: { code: "invalid_request", message: "a request needs an id and a method" } });
      options.api.call(method, params ?? {}).then(
        (result) => send({ id, result: result ?? null }),
        (error: unknown) => send({ id, error: isAppApiError(error) ? { code: error.code, message: error.message } : { code: "internal", message: error instanceof Error ? error.message : String(error) } }),
      );
    });

    socket.on("close", () => {
      clearTimeout(authTimer);
      unsubscribe?.();
      if (authenticated.delete(socket)) announce();
    });
    socket.on("error", (error) => log("ws", "client socket error", error.message));
  });

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(options.port ?? 0, "127.0.0.1", () => {
      http.off("error", reject);
      resolve();
    });
  });
  const address = http.address();
  if (address == null || typeof address === "string") throw new Error("ws server has no port");

  return {
    port: address.port,
    token,
    clientCount: () => authenticated.size,
    async close() {
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

export interface WsEndpoint {
  readonly port: number;
  readonly token: string;
  readonly pid: number;
}

export const wsEndpointPath = (home: string): string => join(home, "ws.json");

/** Publishes where to connect, readable only by the user. Atomic, so a reader never sees half a file. */
export function writeWsEndpoint(home: string, endpoint: WsEndpoint): void {
  const path = wsEndpointPath(home);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(endpoint)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

export function readWsEndpoint(home: string): WsEndpoint | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(wsEndpointPath(home), "utf8"));
    if (isRecord(parsed) && typeof parsed.port === "number" && typeof parsed.token === "string" && typeof parsed.pid === "number") return { port: parsed.port, token: parsed.token, pid: parsed.pid };
  } catch {
    // missing or unreadable: no endpoint
  }
  return null;
}

/** Removes the endpoint file, but only if it is still ours (a newer host may have replaced it). */
export function removeWsEndpoint(home: string, token: string): void {
  const current = readWsEndpoint(home);
  if (current?.token === token && existsSync(wsEndpointPath(home))) rmSync(wsEndpointPath(home), { force: true });
}
