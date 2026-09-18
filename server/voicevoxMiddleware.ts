import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { VOICEVOX_REQUEST_MAX_BYTES } from "../src/voicevoxBackend";

type LocalVoicevoxEnv = {
  VOICEVOX_REMOTE_API_URL?: string;
  VOICEVOX_LOCAL_ACCESS_TOKEN?: string;
};

const sendJson = (response: ServerResponse, status: number, error: string) => {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify({ error }));
};

async function* responseChunks(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return;
      yield chunk.value;
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

/** Only the local Node server sees the relay credential. Never use VITE_ keys. */
export const createVoicevoxMiddleware = (env: LocalVoicevoxEnv, fetcher: typeof fetch = fetch) =>
  async (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/api/voicevox/")) return next();
    const route = url.pathname === "/api/voicevox/status" ? "status"
      : url.pathname === "/api/voicevox/synthesize" ? "synthesize" : null;
    if (!route) return sendJson(response, 404, "この歌声APIはローカル版では利用できません。");
    if (request.method !== (route === "status" ? "GET" : "POST")) return sendJson(response, 405, "Method not allowed");

    // Reject browser requests from other sites, including cross-site GETs.
    const origin = request.headers.origin;
    const site = request.headers["sec-fetch-site"];
    const sameOrigin = origin === `http://${request.headers.host}` || origin === `https://${request.headers.host}`;
    if ((origin && !sameOrigin) || (site && site !== "same-origin" && site !== "none")) {
      return sendJson(response, 403, "同じサイトからのみ利用できます。");
    }
    if (route === "synthesize" && !origin) return sendJson(response, 403, "同じサイトからのみ利用できます。");
    if (route === "synthesize" && !request.headers["content-type"]?.toLowerCase().includes("application/json")) {
      return sendJson(response, 415, "Content-Type must be application/json");
    }
    if (Number(request.headers["content-length"]) > VOICEVOX_REQUEST_MAX_BYTES) return sendJson(response, 413, "歌声データが大きすぎます。");

    let upstream: URL;
    try {
      upstream = new URL(env.VOICEVOX_REMOTE_API_URL ?? "");
      if (upstream.protocol !== "https:" || upstream.username || upstream.password || upstream.pathname !== "/" || upstream.search || upstream.hash) throw new Error();
      if (!/^[A-Za-z0-9_-]{43}$/.test(env.VOICEVOX_LOCAL_ACCESS_TOKEN ?? "")) throw new Error();
    } catch {
      return sendJson(response, 503, "ローカル版のクラウド歌声設定がありません。.env.local の VOICEVOX_REMOTE_API_URL と VOICEVOX_LOCAL_ACCESS_TOKEN を設定して再起動してください。");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), route === "status" ? 60_000 : 180_000);
    const abort = () => { if (!response.writableFinished) controller.abort(); };
    response.once("close", abort);
    try {
      let body: string | undefined;
      if (route === "synthesize") {
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of request) {
          bytes += chunk.length;
          if (bytes > VOICEVOX_REQUEST_MAX_BYTES) return sendJson(response, 413, "歌声データが大きすぎます。");
          chunks.push(Buffer.from(chunk));
        }
        body = Buffer.concat(chunks).toString("utf8");
      }
      const target = new URL(`/api/voicevox/local/${route}`, upstream);
      if (route === "status") target.searchParams.set("backend", url.searchParams.get("backend") ?? "");
      const result = await fetcher(target, {
        method: request.method,
        headers: {
          Authorization: `Bearer ${env.VOICEVOX_LOCAL_ACCESS_TOKEN}`,
          Origin: upstream.origin,
          "Content-Type": "application/json",
        },
        body,
        redirect: "error",
        signal: controller.signal,
      });
      const contentType = result.headers.get("Content-Type") ?? "";
      if (!contentType.includes("application/json") && !(route === "synthesize" && result.ok && contentType.includes("audio/wav"))) {
        await result.body?.cancel();
        return sendJson(response, 502, "クラウド歌声APIから正しい応答を受け取れませんでした。Workerのデプロイと接続先を確認してください。");
      }
      response.statusCode = result.status;
      response.setHeader("Content-Type", contentType);
      response.setHeader("Cache-Control", "no-store");
      for (const header of ["X-Voicevox-Backend", "X-Voicevox-Fallback"]) {
        const value = result.headers.get(header);
        if (value) response.setHeader(header, value);
      }
      if (result.body) await pipeline(Readable.from(responseChunks(result.body)), response);
      else response.end();
    } catch {
      if (!response.headersSent && !response.destroyed) {
        sendJson(response, 502, controller.signal.aborted ? "クラウド歌声サーバーがタイムアウトしました。" : "クラウド歌声サーバーに接続できませんでした。");
      } else if (!response.destroyed) response.destroy();
    } finally {
      clearTimeout(timeout);
      response.off("close", abort);
    }
  };
