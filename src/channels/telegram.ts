import type { Incoming } from "../gateway.ts";

export type TelegramOptions = {
  token: string;
  /** Only accept these chat ids (strings). Empty = accept all. */
  allowedChats?: string[];
  /** Treat this telegram user id as the owner. */
  ownerExternalId?: string;
};

type TgUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    chat: { id: number; type: string; title?: string };
    from?: { id: number; first_name?: string; last_name?: string; username?: string };
    text?: string;
  };
};

/**
 * Telegram adapter: long polling, no public URL, no extra dependency.
 *
 * Polling is chosen over webhooks on purpose — a personal agent runs on a laptop behind
 * NAT, and a tunnel would add a moving part for no benefit. The offset cursor lives in
 * memory, so a restart re-delivers at most one update; the ingest path is idempotent per
 * event because each message becomes a fresh event row.
 */
export class TelegramChannel {
  private offset = 0;
  private readonly options: TelegramOptions;
  private readonly base: string;

  constructor(options: TelegramOptions) {
    this.options = options;
    this.base = `https://api.telegram.org/bot${options.token}`;
  }

  async send(chatId: string, text: string): Promise<void> {
    const body = { chat_id: chatId, text: text.slice(0, 4_000), disable_web_page_preview: true };
    const response = await fetch(`${this.base}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`telegram sendMessage ${response.status}: ${await response.text()}`);
    }
  }

  /** Long-polls forever; resolves only when aborted. */
  async serve(onMessage: (message: Incoming) => Promise<void>, signal?: AbortSignal): Promise<void> {
    while (!signal?.aborted) {
      let updates: TgUpdate[] = [];
      try {
        const response = await fetch(`${this.base}/getUpdates?timeout=25&offset=${this.offset + 1}`, {
          signal: signal as any,
        });
        const payload = (await response.json()) as { ok: boolean; result?: TgUpdate[]; description?: string };
        if (!payload.ok) throw new Error(payload.description ?? "getUpdates failed");
        updates = payload.result ?? [];
      } catch (error) {
        if (signal?.aborted) break;
        console.error(`telegram poll error: ${error instanceof Error ? error.message : String(error)}`);
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        continue;
      }

      for (const update of updates) {
        this.offset = Math.max(this.offset, update.update_id);
        const message = update.message;
        if (!message?.text || !message.from) continue;
        const chatId = String(message.chat.id);
        if (this.options.allowedChats?.length && !this.options.allowedChats.includes(chatId)) {
          console.error(`ignoring chat ${chatId} (not in allow list)`);
          continue;
        }
        const name =
          [message.from.first_name, message.from.last_name].filter(Boolean).join(" ") ||
          message.from.username ||
          `tg_${message.from.id}`;
        await onMessage({
          channel: "telegram",
          chatId,
          chatType: message.chat.type === "private" ? "dm" : "group",
          externalId: String(message.from.id),
          displayName: name,
          text: message.text,
          messageId: String(message.message_id),
          timestamp: new Date(message.date * 1_000).toISOString(),
        });
      }
    }
  }
}
