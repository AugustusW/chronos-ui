// SPDX-License-Identifier: Apache-2.0
//
// Telegram notify credential formats, shared by the IPC-boundary validator (src/main/ipc.ts) and the
// notify service (src/main/services/notify.service.ts) so EVERY place that interpolates a token into
// a URL — or persists one — applies the same check (code review #2/#7). The token is put into the
// api.telegram.org URL path, so a value carrying '/', '..' or query chars could reshape the request.
// The Go schedmgr keeps its own copy (schedmgr/telegram.go) — a different language can't import this —
// but the two regexes must stay in sync.
//
//   token:  "<botId>:<auth>" — a numeric bot id, a colon, then ~35 URL-safe base64 chars
//   chatId: signed integer (groups are negative) or "@channelusername"
export const NOTIFY_TOKEN_RE = /^\d+:[A-Za-z0-9_-]+$/
export const CHAT_ID_RE = /^-?\d+$|^@\w+$/

export const isNotifyTokenFormat = (v: string): boolean => NOTIFY_TOKEN_RE.test(v)
export const isChatIdFormat = (v: string): boolean => CHAT_ID_RE.test(v)
