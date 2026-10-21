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
