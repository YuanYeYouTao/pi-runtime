import { createServer } from "node:http";
import type { Incoming } from "../gateway.ts";
import {
  isUrlVerification,
  parseFeishuMessage,
  unwrapFeishuPayload,
  verifyFeishuSignature,
} from "./feishu.ts";

export type FeishuWebhookOptions = {
  port: number;
  path?: string;
  encryptKey?: string;
  verificationToken?: string;
  allowedChats?: string[];
  /** Resolve a display name from the sender open_id; falls back to the id. */
  resolveName?: (openId: string) => Promise<string>;
  onMessage: (message: Incoming) => Promise<void>;
};

/**
 * Webhook transport for Feishu, as an alternative to the long connection.
 *
 * Two protocol details decide the shape of this file:
 * 1. Feishu retries when the ack is slow (or non-2xx), so the ack must be sent *before* the
 *    agent runs. Otherwise one slow task produces duplicate deliveries — and duplicate
 *    memories, since each delivery would look like a new message.
 * 2. Delivery is signed with the encrypt key, and the whole body may be encrypted. Both are
 *    handled before anything is trusted.
 */
export function startFeishuWebhook(options: FeishuWebhookOptions): Promise<{ close: () => Promise<void>; port: number }> {
  const path = options.path ?? "/feishu/event";

  const server = createServer((request, response) => {
    if (request.method !== "POST" || (request.url ?? "").split("?")[0] !== path) {
      response.writeHead(404).end("not found");
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) {
        response.writeHead(413).end("payload too large");
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const headers: Record<string, string | undefined> = {
        "x-lark-request-timestamp": headerValue(request.headers["x-lark-request-timestamp"]),
        "x-lark-request-nonce": headerValue(request.headers["x-lark-request-nonce"]),
        "x-lark-signature": headerValue(request.headers["x-lark-signature"]),
      };

      let payload: any;
      try {
        if (options.encryptKey && !verifyFeishuSignature(headers, raw, options.encryptKey)) {
          response.writeHead(401).end("bad signature");
          return;
        }
        payload = unwrapFeishuPayload(raw, options.encryptKey);
      } catch (error) {
        console.error(`feishu webhook rejected: ${error instanceof Error ? error.message : String(error)}`);
        response.writeHead(400).end("bad payload");
        return;
      }

      if (isUrlVerification(payload)) {
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ challenge: payload.challenge }));
        return;
      }

      const token = payload?.header?.token ?? payload?.token;
      if (options.verificationToken && token !== options.verificationToken) {
        response.writeHead(403).end("bad token");
        return;
      }

      // Ack first: the agent may take minutes, and Feishu retries anything it waits for.
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));

      void (async () => {
        try {
          const eventType = payload?.header?.event_type ?? payload?.event?.type;
          if (eventType !== "im.message.receive_v1") return;
          const base = parseFeishuMessage(payload);
          if (!base) return;
          if (options.allowedChats?.length && !options.allowedChats.includes(base.chatId)) {
            console.error(`ignoring feishu chat ${base.chatId} (not in allow list)`);
            return;
          }
          const displayName = options.resolveName ? await options.resolveName(base.externalId) : base.displayName;
          await options.onMessage({ ...base, displayName });
        } catch (error) {
          console.error(`feishu webhook handler failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      })();
    });
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(options.port, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : options.port;
      resolve({
        port,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
