import { atom } from "jotai"

export type ChatInspectorPage =
  | "overview"
  | "response"
  | "thoughts"
  | "work"
  | "artifacts"
  | "evidence"
  | "events"
  | "voice"

export interface ChatInspectorSelection {
  chatId: string
  messageId?: string
  runId?: string
  nodeId?: string
  page: ChatInspectorPage
}

export const chatInspectorAtom = atom<ChatInspectorSelection | null>(null)

export const openChatInspectorAtom = atom(
  null,
  (
    _get,
    set,
    selection: Omit<ChatInspectorSelection, "page"> & {
      page?: ChatInspectorPage
    },
  ) => {
    set(chatInspectorAtom, {
      chatId: selection.chatId,
      messageId: selection.messageId,
      runId: selection.runId,
      nodeId: selection.nodeId,
      page: selection.page ?? "overview",
    })
  },
)

export const closeChatInspectorAtom = atom(null, (_get, set) => {
  set(chatInspectorAtom, null)
})

export const setChatInspectorPageAtom = atom(
  null,
  (get, set, page: ChatInspectorPage) => {
    const current = get(chatInspectorAtom)
    if (!current) return
    set(chatInspectorAtom, { ...current, page })
  },
)

export function isChatInspectorOpenFor(
  selection: ChatInspectorSelection | null,
  chatId: string,
): boolean {
  return selection?.chatId === chatId
}
