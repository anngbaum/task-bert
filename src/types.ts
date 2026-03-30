export interface Handle {
  id: number;
  identifier: string;
  service: string | null;
  person_centric_id: string | null;
  display_name: string | null;
}

export interface Chat {
  id: number;
  chat_identifier: string;
  service_name: string | null;
  display_name: string | null;
}

export interface RawMessage {
  id: number;
  guid: string;
  text: string | null;
  attributedBody: Buffer | null;
  is_from_me: number;
  date: number;
  date_read: number | null;
  date_delivered: number | null;
  handle_id: number | null;
  service: string | null;
  associated_message_type: number;
  thread_originator_guid: string | null;
  balloon_bundle_id: string | null;
  has_attachments: number;
}

export interface Message {
  id: number;
  guid: string;
  text: string | null;
  is_from_me: boolean;
  date: Date | null;
  date_read: Date | null;
  date_delivered: Date | null;
  handle_id: number | null;
  service: string | null;
  associated_message_type: number;
  thread_originator_guid: string | null;
  balloon_bundle_id: string | null;
  has_attachments: boolean;
}

export interface ChatMessageJoin {
  chat_id: number;
  message_id: number;
}

export interface ChatHandleJoin {
  chat_id: number;
  handle_id: number;
}

export interface Attachment {
  id: number;
  guid: string;
  filename: string | null;
  mime_type: string | null;
  uti: string | null;
  total_bytes: number | null;
  transfer_name: string | null;
  is_sticker: boolean;
  transfer_state: number;
}

export interface MessageAttachmentJoin {
  message_id: number;
  attachment_id: number;
}

export interface LinkPreview {
  message_id: number;
  original_url: string;
  canonical_url: string | null;
  title: string | null;
  summary: string | null;
  item_type: string | null;
  author: string | null;
}

export interface SearchResultLinkPreview {
  original_url: string;
  canonical_url: string | null;
  title: string | null;
  summary: string | null;
  item_type: string | null;
  author: string | null;
}

export interface SearchResult {
  id: number;
  text: string;
  date: Date | null;
  is_from_me: boolean;
  sender: string | null;
  chat_name: string | null;
  score: number;
  rank?: number;
  link_preview: SearchResultLinkPreview | null;
}

export interface SearchOptions {
  mode: 'text' | 'semantic' | 'hybrid';
  from?: string;
  handleIds?: number[];
  /** Filter to messages in conversations that include these people (AND logic) */
  withContacts?: string[];
  groupChatName?: string;
  after?: string;
  before?: string;
  fromMe?: boolean;
  toMe?: boolean;
  limit: number;
  offset: number;
  context: number;
}

export interface ContextMessage {
  id: number;
  text: string | null;
  date: Date | null;
  is_from_me: boolean;
  sender: string | null;
}

// Thread API types

export type ThreadCursor = string;

export interface ThreadLinkPreview {
  original_url: string;
  canonical_url: string | null;
  title: string | null;
  summary: string | null;
  item_type: string | null;
  author: string | null;
}

export interface ThreadAttachment {
  id: number;
  filename: string | null;
  mime_type: string | null;
  uti: string | null;
  total_bytes: number | null;
  transfer_name: string | null;
  is_sticker: boolean;
}

export interface ThreadMessage {
  id: number;
  text: string | null;
  date: string | null;
  is_from_me: boolean;
  sender: string | null;
  service: string | null;
  thread_originator_guid: string | null;
  has_attachments: boolean;
  attachments: ThreadAttachment[];
  link_preview: ThreadLinkPreview | null;
}

export interface ThreadChatInfo {
  chat_id: number;
  display_name: string | null;
  chat_identifier: string;
  participants: string[];
}

export interface ThreadResponse {
  chat: ThreadChatInfo;
  anchor_message_id: number;
  messages: ThreadMessage[];
  cursors: { older: ThreadCursor | null; newer: ThreadCursor | null };
  has_older: boolean;
  has_newer: boolean;
}
