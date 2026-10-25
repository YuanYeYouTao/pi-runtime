import * as Lark from "@larksuiteoapi/node-sdk";
import type { Incoming } from "../gateway.ts";

export type FeishuOptions = {
  appId: string;
  appSecret: string;
  /** Set when event encryption is enabled in the console. */
  encryptKey?: string;
  verificationToken?: string;
  /** Accept only these chat ids. Empty = accept all. */
  allowedChats?: string[];
};

/**
 * Feishu (Lark) adapter over the long-connection transport.
 *
 * Long connection instead of a webhook: the agent runs on a laptop without a public
 * address, and Feishu's WS mode is the only setup that needs nothing but outbound TLS.
 * The trade-off is that the console must select "使用长连接接收事件" — a webhook deployment
 * would need this file's `serve` to become an HTTP handler instead.
 */
export class FeishuChannel {
  private readonly options: FeishuOptions;
  private readonly client: Lark.Client;
  private ws?: Lark.WSClient;
  private readonly names = new Map<string, string>();

  constructor(options: FeishuOptions) {
    this.options = options;
    this.client = new Lark.Client({ appId: options.appId, appSecret: options.appSecret });
  }

  async send(chatId: string, text: string): Promise<void> {
    await this.client.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text: text.slice(0, 4_000) }),
      },
    });
  }

  /**
   * Feishu events carry an open_id, not a display name. Resolving the name needs the
   * contact scope; when the app lacks it we fall back to the id rather than failing the
   * message — a mislabelled speaker is recoverable, a dropped message is not.
   */
  private async displayName(openId: string): Promise<string> {
    const cached = this.names.get(openId);
    if (cached) return cached;
    let name = openId;
    try {
      const response: any = await this.client.contact.v3.user.get({
        params: { user_id_type: "open_id" },
        path: { user_id: openId },
      });
      const resolved = response?.data?.user?.name;
      if (typeof resolved === "string" && resolved.trim()) name = resolved.trim();
    } catch {
      /* no contact scope — keep the id */
    }
    this.names.set(openId, name);
    return name;
  }

  async serve(onMessage: (message: Incoming) => Promise<void>): Promise<void> {
    const dispatcher = new Lark.EventDispatcher({
      encryptKey: this.options.encryptKey,
      verificationToken: this.options.verificationToken,
    }).register({
      "im.message.receive_v1": async (payload: any) => {
        const base = parseFeishuMessage(payload);
        if (!base) return;
        if (this.options.allowedChats?.length && !this.options.allowedChats.includes(base.chatId)) {
          console.error(`ignoring feishu chat ${base.chatId} (not in allow list)`);
          return;
        }
        const displayName = await this.displayName(base.externalId);
        await onMessage({ ...base, displayName });
      },
    });

    this.ws = new Lark.WSClient({
      appId: this.options.appId,
      appSecret: this.options.appSecret,
      loggerLevel: Lark.LoggerLevel.warn,
    });

    await this.ws.start({ eventDispatcher: dispatcher });
    console.log("feishu long connection established");
  }

  close(): void {
    this.ws?.close({ force: true });
  }
}

/**
 * Normalization is exported so it can be tested without credentials: the payload shape is
 * the part that breaks when Feishu changes schema or when a message is not plain text.
 */
export function parseFeishuMessage(payload: any): Incoming | null {
  const event = payload?.event ?? payload;
  const message = event?.message;
  const sender = event?.sender;
  if (!message?.chat_id || typeof message.content !== "string") return null;
  if (message.message_type !== "text") return null;

  let text = "";
  try {
    text = String(JSON.parse(message.content)?.text ?? "");
  } catch {
    return null;
  }
  // Feishu inlines mentions as @_user_1 placeholders; they are noise for memory extraction.
  text = text.replace(/@_user_\d+/g, "").trim();
  if (!text) return null;

  const ids = sender?.sender_id ?? {};
  const externalId = String(ids.open_id ?? ids.user_id ?? ids.union_id ?? "unknown");
  if (externalId === "unknown") return null;

  return {
    channel: "feishu",
    chatId: String(message.chat_id),
    chatType: message.chat_type === "p2p" ? "dm" : "group",
    externalId,
    displayName: externalId,
    text,
    messageId: message.message_id ? String(message.message_id) : undefined,
    timestamp: message.create_time ? new Date(Number(message.create_time)).toISOString() : undefined,
  };
}
