import {
  BaseEdge,
  EdgeLabelRenderer,
  type EdgeProps,
  getBezierPath,
} from "@xyflow/react"
import { memo } from "react"

function FlowEdgeInner({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps) {
  const animated = Boolean(
    (data as { animated?: boolean } | undefined)?.animated,
  )

  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  })

  // The monitor canvas is frequently viewed on small screens at reduced zoom.
  // Keep idle dependency lines bright enough to remain visible against dark themes.
  const color = animated
    ? "var(--primary)"
    : "color-mix(in srgb, var(--foreground) 58%, transparent)"

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: color,
          strokeWidth: animated ? 3 : 2.25,
          filter: animated
            ? "drop-shadow(0 0 4px color-mix(in srgb, var(--primary) 65%, transparent))"
            : undefined,
        }}
      />
      {animated && (
        <EdgeLabelRenderer>
          <svg
            className="pointer-events-none absolute inset-0 overflow-visible"
            style={{ width: 0, height: 0 }}
          >
            <defs>
              <path id={`${id}-path`} d={edgePath} />
            </defs>
            {[0, 0.33, 0.66].map((offset) => (
              <circle key={offset} r={2.8} fill="var(--primary)">
                <animateMotion
                  dur="1.4s"
                  repeatCount="indefinite"
                  begin={`${offset * 1.4}s`}
                >
                  <mpath href={`#${id}-path`} />
                </animateMotion>
              </circle>
            ))}
          </svg>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

export const FlowEdge = memo(FlowEdgeInner)
