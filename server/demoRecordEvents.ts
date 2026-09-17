import type { IncomingMessage, ServerResponse } from "http";

export type DemoRecordChange = {
  kind: "created" | "deleted" | "updated";
  recordId: string;
};

/** One hub belongs to one local server and its configured demo-record directory. */
export const createDemoRecordEventHub = (heartbeatMs = 15_000) => {
  const clients = new Map<ServerResponse, () => void>();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const write = (response: ServerResponse, message: string) => {
    if (response.destroyed || response.writableEnded) {
      clients.get(response)?.();
      return;
    }
    try {
      // Reconnecting is preferable to buffering an unbounded stream for a slow client.
      if (!response.write(message)) {
        clients.get(response)?.();
        response.destroy();
      }
    } catch {
      clients.get(response)?.();
      response.destroy();
    }
  };

  const connect = (_request: IncomingMessage, response: ServerResponse) => {
    if (closed) {
      response.statusCode = 503;
      response.end();
      return;
    }
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Accel-Buffering", "no");

    const cleanup = () => {
      clients.delete(response);
      response.off("close", cleanup);
      response.off("error", cleanup);
      if (clients.size === 0 && heartbeat) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
    };
    clients.set(response, cleanup);
    response.once("close", cleanup);
    response.once("error", cleanup);
    response.flushHeaders();
    // Clients reconcile their list on every ready, including reconnects. No replay log
    // is required and events missed while disconnected cannot leave stale records.
    write(response, "retry: 2000\nevent: ready\ndata: {}\n\n");

    if (clients.size > 0 && !heartbeat) {
      heartbeat = setInterval(() => {
        for (const client of clients.keys()) write(client, ": heartbeat\n\n");
      }, heartbeatMs);
      heartbeat.unref();
    }
  };

  const publish = (change: DemoRecordChange) => {
    if (closed) return;
    const message = `event: change\ndata: ${JSON.stringify(change)}\n\n`;
    for (const client of clients.keys()) write(client, message);
  };

  const close = () => {
    if (closed) return;
    closed = true;
    for (const [response, cleanup] of clients) {
      cleanup();
      response.end();
    }
  };

  return { connect, publish, close };
};

export type DemoRecordEventHub = ReturnType<typeof createDemoRecordEventHub>;
