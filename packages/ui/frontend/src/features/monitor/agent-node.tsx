import { Handle, type NodeProps, Position } from "@xyflow/react"
import { AnimatePresence, motion } from "framer-motion"
import { memo, useMemo } from "react"

import {
  activityStatusLabel,
  activitySummary,
  activityTitle,
} from "@/features/monitor/activity-copy"
import { StatusIcon } from "@/features/monitor/node-visuals"
import {
  NODE_TYPE_ACCENT,
  NODE_TYPE_ICON,
  NODE_TYPE_LABEL,
  STATUS_COLOR,
} from "@/features/monitor/node-visuals.constants"
import { type MonitorNode, toggleNodeUIState } from "@/features/monitor/store"
import { cn } from "@/lib/utils"

function formatDuration(ms?: number): string | null {
  if (!ms || ms < 0) return null
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function AgentNodeInner({ data }: NodeProps) {
  const node = (data as { node: MonitorNode }).node
  const Icon = NODE_TYPE_ICON[node.type]
  const accent = NODE_TYPE_ACCENT[node.type]
  const statusColor = STATUS_COLOR[node.status]
  const expanded = node.uiState === "expanded"
  const duration = useMemo(
    () => formatDuration(node.durationMs),
    [node.durationMs],
  )

  const isActive = node.status === "running" || node.status === "retrying"

  return (
    <div
      onDoubleClick={(e) => {
        e.stopPropagation()
        toggleNodeUIState(node.id)
      }}
      className="nodrag-target"
      style={{ cursor: "pointer" }}
    >
      <Handle
        type="target"
        position={Position.Left}
        style={{ background: accent, width: 8, height: 8, border: "none" }}
      />
      <Handle
        type="source"
        position={Position.Right}
        style={{ background: accent, width: 8, height: 8, border: "none" }}
      />

      <motion.div
        layout
        transition={{ type: "spring", stiffness: 320, damping: 28, mass: 0.6 }}
        animate={{
          boxShadow: isActive
            ? `0 0 0 1px ${accent}55, 0 0 22px 2px ${accent}33`
            : `0 0 0 1px rgba(255,255,255,0.06), 0 2px 10px rgba(0,0,0,0.4)`,
        }}
        className={cn(
          "overflow-hidden rounded-xl border border-white/[0.06] bg-[#181a20] select-none",
          "font-mono",
        )}
        style={{
          width: expanded ? 268 : 56,
          height: expanded ? 168 : 56,
        }}
      >
        <AnimatePresence mode="wait" initial={false}>
          {expanded ? (
            <motion.div
              key="expanded"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="flex h-full flex-col"
            >
              {/* Title bar */}
              <div
                className="flex items-center gap-2 px-3 py-2"
                style={{
                  background: `linear-gradient(90deg, ${accent}22, transparent)`,
                  borderBottom: "1px solid rgba(255,255,255,0.06)",
                }}
              >
                <Icon size={13} style={{ color: accent }} />
                <span
                  className="truncate text-[11px] font-semibold tracking-wide text-white/90"
                  title={activityTitle(node)}
                >
                  {activityTitle(node)}
                </span>
                <span className="ml-auto shrink-0">
                  <StatusIcon status={node.status} size={13} />
                </span>
              </div>

              {/* Body */}
              <div className="flex flex-1 flex-col gap-1.5 overflow-hidden px-3 py-2 text-[10.5px] leading-tight text-white/60">
                <div className="flex items-center justify-between">
                  <span className="text-white/35">Activity</span>
                  <span style={{ color: accent }}>
                    {NODE_TYPE_LABEL[node.type]}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-white/35">Status</span>
                  <span style={{ color: statusColor }} className="capitalize">
                    {activityStatusLabel(node.status)}
                  </span>
                </div>
                {duration && (
                  <div className="flex items-center justify-between">
                    <span className="text-white/35">Duration</span>
                    <span className="text-white/70">{duration}</span>
                  </div>
                )}
                {node.parallel && (
                  <div className="flex items-center justify-between">
                    <span className="text-white/35">Mode</span>
                    <span className="text-white/70">Parallel</span>
                  </div>
                )}
                <p
                  className={cn(
                    "mt-1 line-clamp-3 text-[11px] leading-4 break-words",
                    node.status === "failed"
                      ? "text-red-300/80"
                      : "text-white/50",
                  )}
                >
                  {activitySummary(node)}
                </p>
              </div>

              {/* Progress bar for running state */}
              {isActive && (
                <div className="h-[2px] w-full overflow-hidden bg-white/5">
                  <motion.div
                    className="h-full"
                    style={{ background: accent }}
                    animate={{ x: ["-100%", "100%"] }}
                    transition={{
                      duration: 1.1,
                      repeat: Infinity,
                      ease: "linear",
                    }}
                  />
                </div>
              )}
            </motion.div>
          ) : (
            <motion.div
              key="minimized"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="relative flex h-full w-full items-center justify-center"
              title={node.label}
            >
              <Icon size={20} style={{ color: accent }} />
              <span className="absolute right-0.5 bottom-0.5">
                <StatusIcon status={node.status} size={11} />
              </span>
              {isActive && (
                <motion.div
                  className="pointer-events-none absolute inset-0 rounded-xl"
                  style={{ border: `1px solid ${accent}` }}
                  animate={{ opacity: [0.15, 0.6, 0.15] }}
                  transition={{
                    duration: 1.6,
                    repeat: Infinity,
                    ease: "easeInOut",
                  }}
                />
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  )
}

export const AgentNode = memo(AgentNodeInner)
