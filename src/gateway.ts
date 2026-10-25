import type { Store } from "./db.ts";
import { Members } from "./members.ts";

export type Incoming = {
  channel: string;
  chatId: string;
  chatType: "group" | "dm";
  externalId: string;
  displayName: string;
  text: string;
  messageId?: string;
  timestamp?: string;
};

export type GatewayDeps = {
  store: Store;
  members: Members;
  dataDir: string;
  /** The person this agent belongs to. Ownership is configured, never inferred. */
  ownerName: string;
  /** Channel ids that also count as the owner, for when the display name differs. */
  ownerIds?: string[];
};

export type IngestResult = {
  thread: string;
  eventId: number;
  speaker: string;
  isOwner: boolean;
  duplicate?: boolean;
};

/**
 * One entry point for every channel.
 *
 * A message becomes a numbered conversation event immediately — before any model call —
 * because memory evidence must survive a failed reply. The thread is namespaced by channel
 * so the same person on two channels does not share a conversation history by accident.
 */
export function ingest(deps: GatewayDeps, message: Incoming): IngestResult {
  const { store, members } = deps;
  const thread = `${message.channel}:${message.chatId}`;

  // Transport redelivery must not create a second event: one message, one memory source.
  if (message.messageId && !store.claimMessage(message.channel, message.messageId)) {
    return { thread, eventId: -1, speaker: message.displayName, isOwner: false, duplicate: true };
  }

  // Ownership is decided by configured name or id, not by "whoever spoke first". Feishu and
  // Telegram deliver their own display names, so an id list is the reliable fallback when the
  // profile name is not the owner's canonical name.
  const isOwner =
    message.displayName === deps.ownerName || Boolean(deps.ownerIds?.includes(message.externalId));
  const member = members.upsert(message.channel, message.externalId, message.displayName, isOwner);

  const eventId = store.addConversationEvent(thread, member.display_name, "user", message.text.trim(), null);
  return { thread, eventId, speaker: member.display_name, isOwner: Boolean(member.is_owner) };
}

/** Assistant output also becomes an event, so evidence can point at it too. */
export function recordReply(deps: GatewayDeps, thread: string, text: string, speaker = "agent"): number {
  return deps.store.addConversationEvent(thread, speaker, "assistant", text.trim(), null);
}
