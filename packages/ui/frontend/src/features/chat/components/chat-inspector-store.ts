import { atom } from "jotai"

export type ChatInspectorPage = "overview" | "execution" | "outputs" | "timeline"

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
