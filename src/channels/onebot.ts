export type OneBotMessage = {
  kind: "private" | "group";
  /** Stable chat key for the runtime's thread scoping. */
  chatId: string;
  userId: string;
  groupId?: string;
  messageId: string;
  nickname?: string;
  text: string;
  /** Group messages count only when the bot was @-mentioned; private ones always do. */
  addressed: boolean;
};

type Segment = { type?: string; data?: Record<string, unknown> };

/** OneBot may send `message` as segments or as a CQ-code string; both are normalised here. */
function toSegments(message: unknown): Segment[] {
  if (Array.isArray(message)) return message as Segment[];
  if (typeof message === "string") {
    const segments: Segment[] = [];
    const pattern = /\[CQ:(\w+)((?:,[^\]]*)?)\]/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(message)) !== null) {
      if (match.index > lastIndex) segments.push({ type: "text", data: { text: message.slice(lastIndex, match.index) } });
      const params: Record<string, string> = {};
      for (const pair of match[2].split(",").filter(Boolean)) {
        const [key, value] = pair.split("=");
        if (key) params[key] = decodeURIComponent(value ?? "");
      }
      segments.push({ type: match[1], data: params });
      lastIndex = pattern.lastIndex;
    }
    if (lastIndex < message.length) segments.push({ type: "text", data: { text: message.slice(lastIndex) } });
    return segments;
  }
  return [];
}

/**
 * Parse a OneBot v11 event into the runtime's incoming shape.
 *
 * Returns null for anything that is not a message worth answering: heartbeats, notices,
 * the bot's own messages and empty text (images, faces, cards).
 */
export function parseOneBotEvent(payload: any, options: { botUin?: string } = {}): OneBotMessage | null {
  if (!payload || payload.post_type !== "message") return null;

  const selfId = String(payload.self_id ?? "");
  const userId = String(payload.user_id ?? "");
  if (options.botUin && userId === options.botUin) return null;
  if (selfId && userId === selfId) return null;

  const segments = toSegments(payload.message);
  const text = segments
    .filter((segment) => segment.type === "text")
    .map((segment) => String(segment.data?.text ?? ""))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;

  const mentioned = segments.some(
    (segment) => segment.type === "at" && (options.botUin ? String(segment.data?.qq) === options.botUin : true),
  );
  const isGroup = payload.message_type === "group";
  if (!isGroup && payload.message_type !== "private") return null;

  const groupId = isGroup ? String(payload.group_id ?? "") : undefined;
  if (isGroup && !groupId) return null;

  return {
    kind: isGroup ? "group" : "private",
    chatId: isGroup ? `qq:group:${groupId}` : `qq:user:${userId}`,
    userId,
    groupId,
    messageId: String(payload.message_id ?? ""),
    nickname: payload.sender?.card || payload.sender?.nickname || undefined,
    text,
    addressed: isGroup ? mentioned : true,
  };
}

/**
 * Map a parsed QQ message onto the runtime's channel-agnostic shape.
 *
 * Structural typing keeps this file independent of the gateway module; the shape is checked at
 * the call site, where it is handed to `ingest`.
 */
export function oneBotToIncoming(message: OneBotMessage) {
  return {
    channel: "qq",
    chatId: message.chatId,
    chatType: message.kind === "group" ? ("group" as const) : ("dm" as const),
    externalId: message.userId,
    displayName: message.nickname ?? message.userId,
    text: message.text,
    messageId: message.messageId,
    addressed: message.addressed,
  };
}

/** `qq:group:555` / `qq:user:999` back into a send target. */
export function sendTargetFromChatId(chatId: string): SendTarget {
  const [scope, id] = chatId.replace(/^qq:/, "").split(":");
  return { kind: scope === "group" ? "group" : "private", id };
}

export type SendTarget = { kind: "private" | "group"; id: string };

/** The HTTP body OneBot expects for a text reply. */
export function buildSendBody(target: SendTarget, text: string): { endpoint: string; body: Record<string, unknown> } {
  return target.kind === "group"
    ? { endpoint: "send_group_msg", body: { group_id: Number(target.id), message: text } }
    : { endpoint: "send_private_msg", body: { user_id: Number(target.id), message: text } };
}

export type OneBotOptions = {
  wsUrl: string;
  httpUrl: string;
  accessToken?: string;
  botUin?: string;
  allowedUsers?: string[];
  allowedGroups?: string[];
};

/**
 * Minimal OneBot v11 client: one WebSocket in, HTTP out.
 *
 * Deliberately dependency-free — Node's global `fetch` and `WebSocket` cover both halves, and a
 * third-party protocol bridge is already the risky part of this path; adding libraries would only
 * add failure modes.
 */
export class OneBotClient {
  private readonly options: OneBotOptions;

  constructor(options: OneBotOptions) {
    this.options = options;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.options.accessToken) headers.authorization = `Bearer ${this.options.accessToken}`;
    return headers;
  }

  async send(target: SendTarget, text: string): Promise<void> {
    const { endpoint, body } = buildSendBody(target, text);
    const response = await fetch(`${this.options.httpUrl.replace(/\/$/, "")}/${endpoint}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`onebot ${endpoint} ${response.status}`);
    const payload: any = await response.json().catch(() => null);
    if (payload && payload.status === "failed") throw new Error(`onebot ${endpoint}: ${payload.wording ?? payload.retcode}`);
  }

  /** Connect, dispatch messages, reconnect with backoff. Resolves only on an AbortSignal. */
  async run(onMessage: (message: OneBotMessage) => Promise<void>, signal?: AbortSignal): Promise<void> {
    let delay = 1_000;
    while (!signal?.aborted) {
      try {
        await this.session(onMessage, signal);
        delay = 1_000;
      } catch (error) {
        console.error(`onebot: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (signal?.aborted) break;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 30_000);
    }
  }

  private session(onMessage: (message: OneBotMessage) => Promise<void>, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = this.options.accessToken
        ? `${this.options.wsUrl}${this.options.wsUrl.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(this.options.accessToken)}`
        : this.options.wsUrl;
      const socket = new WebSocket(url);

      socket.addEventListener("open", () => console.error("onebot: connected"));
      socket.addEventListener("error", () => reject(new Error("websocket error")));
      socket.addEventListener("close", () => resolve());
      socket.addEventListener("message", (event) => {
        let payload: any;
        try {
          payload = JSON.parse(String((event as MessageEvent).data));
        } catch {
          return;
        }
        const message = parseOneBotEvent(payload, { botUin: this.options.botUin });
        if (!message) return;
        if (message.kind === "group" && this.options.allowedGroups?.length && !this.options.allowedGroups.includes(message.groupId!)) return;
        if (message.kind === "private" && this.options.allowedUsers?.length && !this.options.allowedUsers.includes(message.userId)) return;
        void onMessage(message).catch((error) => console.error(`onebot handler: ${error instanceof Error ? error.message : String(error)}`));
      });

      signal?.addEventListener("abort", () => {
        try {
          socket.close();
        } catch {
          /* already closed */
        }
        resolve();
      });
    });
  }
}
