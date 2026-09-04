import { useAtomValue } from "jotai"
import { useEffect, useRef, useState } from "react"

import { clearGatewayLogs, getGatewayLogs } from "@/api/gateway"
import { gatewayAtom } from "@/store/gateway"

export function useGatewayLogs() {
  const [logs, setLogs] = useState<string[]>([])
  const [clearing, setClearing] = useState(false)
  const logOffsetRef = useRef(0)
  const logRunIdRef = useRef(-1)
  const syncTokenRef = useRef(0)

  const gateway = useAtomValue(gatewayAtom)

  const clearLogs = async () => {
    setClearing(true)
    try {
      // clearGatewayLogs() throws on any non-2xx response, which includes
      // the backend's "partial_failure" status (HTTP 500) for a log file
      // that could not be truncated. Only touch local state — clearing the
      // visible log list and advancing the offset — once that has
      // succeeded, so a failed clear leaves the UI showing the log lines
      // that are still actually on disk. The caller (logs-page.tsx) is
      // responsible for surfacing the error to the user; re-throw instead
      // of swallowing it here (#123).
      const data = await clearGatewayLogs()
      syncTokenRef.current += 1
      setLogs([])
      logOffsetRef.current = data.log_total ?? 0
      if (data.log_run_id !== undefined) {
        logRunIdRef.current = data.log_run_id
      }
    } finally {
      setClearing(false)
    }
  }

  useEffect(() => {
    let mounted = true
    let timeout: ReturnType<typeof setTimeout>

    const fetchLogs = async () => {
      if (
        !mounted ||
        !["running", "starting", "restarting", "stopping"].includes(
          gateway.status,
        )
      ) {
        if (mounted) {
          timeout = setTimeout(fetchLogs, 1000)
        }
        return
      }

      try {
        const requestToken = syncTokenRef.current
        const requestOffset = logOffsetRef.current
        const requestRunId = logRunIdRef.current
        const data = await getGatewayLogs({
          log_offset: requestOffset,
          log_run_id: requestRunId,
        })

        if (!mounted || requestToken !== syncTokenRef.current) {
          return
        }

        if (data.log_run_id !== undefined && data.log_run_id !== requestRunId) {
          logRunIdRef.current = data.log_run_id
          logOffsetRef.current = 0
          if (data.logs) {
            setLogs(data.logs)
            logOffsetRef.current = data.log_total || data.logs.length
          }
        } else if (data.logs && data.logs.length > 0) {
          const nextLogs = data.logs
          setLogs((prev) => [...prev, ...nextLogs])
          logOffsetRef.current =
            data.log_total || logOffsetRef.current + nextLogs.length
        }
      } catch {
        // Ignore simple fetch errors during polling.
      } finally {
        if (mounted) {
          timeout = setTimeout(fetchLogs, 1000)
        }
      }
    }

    fetchLogs()

    return () => {
      mounted = false
      clearTimeout(timeout)
    }
  }, [gateway.status])

  return {
    clearLogs,
    clearing,
    logs,
  }
}
