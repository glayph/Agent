export interface AgentRunsSearchState {
  q: string
  query?: string
  status: string
  run: string
  step: string
  page: number
}

export function normalizeAgentRunsSearch(
  search: Record<string, unknown> | Partial<AgentRunsSearchState>,
): AgentRunsSearchState {
  const q = typeof search.q === "string" ? search.q : ""
  const query = typeof search.query === "string" ? search.query : q
  const status = typeof search.status === "string" ? search.status : "all"
  const run = typeof search.run === "string" ? search.run : ""
  const step = typeof search.step === "string" ? search.step : ""
  const rawPage = typeof search.page === "number" ? search.page : Number(search.page)
  const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1
  return { q: query, query, status, run, step, page }
}
