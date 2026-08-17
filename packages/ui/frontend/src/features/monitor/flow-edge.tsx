import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from "@xyflow/react"
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
  const animated = Boolean((data as { animated?: boolean } | undefined)?.animated)

  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  })

  const color = animated ? "#38bdf8" : "rgba(255,255,255,0.14)"

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: color,
          strokeWidth: animated ? 1.75 : 1.25,
          filter: animated ? "drop-shadow(0 0 3px #38bdf8aa)" : undefined,
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
              <circle key={offset} r={2.6} fill="#8be9ff">
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
