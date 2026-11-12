import { describe, expect, it, vi } from "vitest"

import type { AutonomyStatus } from "@/features/activity/activity-api"
import { buildStatusPills } from "./chat-page"

const labels = {
  gatewayOnline: "Gateway connected",
  gatewayConnecting: "Connecting",
  gatewayDisconnected: "Disconnected",
  gatewayConnectionError: "WebSocket error",
  gatewayUnknown: "Gateway status unknown",
  gatewayStarting: "Gateway starting",
  gatewayRestarting: "Gateway restarting",
  gatewayStopping: "Gateway stopping",
  gatewayStopped: "Gateway stopped",
  gatewayError: "Gateway error",
  chatWorking: "Miki is responding",
  autonomousWorking: "Miki is working autonomously",
  autonomyPaused: "Autonomy paused",
  agentReady: "Miki ready",
  activeGoals: (count: number) => `${count} active goals`,
}

const onOpenActivity = vi.fn()
const onOpenHealth = vi.fn()

function build(input: {
  connectionState?: "connected" | "connecting" | "disconnected" | "error"
  gatewayState?: "running" | "starting" | "restarting" | "stopping" | "stopped" | "error" | "unknown"
  isTyping?: boolean
  autonomyStatus?: AutonomyStatus | null
}) {
  return buildStatusPills({
    connectionState: input.connectionState ?? "connected",
    gatewayState: input.gatewayState ?? "running",
    isTyping: input.isTyping ?? false,
    autonomyStatus: input.autonomyStatus ?? null,
    labels,
    onOpenActivity,
    onOpenHealth,
  })
}

describe("Chat workspace status pills", () => {
  it("reports connected gateway and ready agent when online and idle", () => {
    expect(build({})).toEqual([
      { label: "Gateway connected", tone: "success", onClick: onOpenHealth },
      { label: "Miki ready", tone: "neutral", onClick: onOpenActivity },
    ])
  })

  it("reports the live gateway connection state", () => {
    expect(build({ connectionState: "disconnected" })).toEqual([
      { label: "Disconnected", tone: "warning", onClick: onOpenHealth },
      { label: "Miki ready", tone: "neutral", onClick: onOpenActivity },
    ])
  })

  it("reports foreground chat activity", () => {
    expect(build({ isTyping: true })).toEqual([
      { label: "Gateway connected", tone: "success", onClick: onOpenHealth },
      { label: "Miki is responding", tone: "success", onClick: onOpenActivity },
    ])
  })

  it("reports autonomous work and the exact number of active goals", () => {
    const autonomyStatus = {
      enabled: true,
      paused: false,
      in_flight: false,
      running_goals: [
        { id: 1, title: "First", status: "active", progress: 10, run_id: null, started_at: null, last_progress_at: null },
        { id: 2, title: "Second", status: "running", progress: 30, run_id: null, started_at: null, last_progress_at: null },
        { id: 3, title: "Finished", status: "completed", progress: 100, run_id: null, started_at: null, last_progress_at: null },
      ],
    } as AutonomyStatus

    expect(build({ autonomyStatus })).toEqual([
      { label: "Gateway connected", tone: "success", onClick: onOpenHealth },
      { label: "Miki is working autonomously", tone: "success", onClick: onOpenActivity },
      { label: "2 active goals", tone: "info", onClick: onOpenActivity },
    ])
  })

  it("reports paused autonomy without claiming the agent is offline", () => {
    const autonomyStatus = {
      enabled: true,
      paused: true,
      in_flight: false,
    } as AutonomyStatus

    expect(build({ autonomyStatus })).toEqual([
      { label: "Gateway connected", tone: "success", onClick: onOpenHealth },
      { label: "Autonomy paused", tone: "warning", onClick: onOpenActivity },
    ])
  })

  it("reports an in-flight ambient decision even when no goal has been queued yet", () => {
    const autonomyStatus = {
      enabled: true,
      paused: false,
      in_flight: false,
      proactive_loop: {
        enabled: true,
        startup_decision: true,
        llm_when_idle: true,
        mode: "event_driven_continuous",
        ambient_in_flight: true,
        wake_pending: false,
        last_decision_at: null,
        quiet_observation_interval_seconds: 5,
        failure_streak: 0,
        circuit_open: false,
        next_decision_in_seconds: 0,
      },
    } as AutonomyStatus

    expect(build({ autonomyStatus })).toEqual([
      { label: "Gateway connected", tone: "success", onClick: onOpenHealth },
      { label: "Miki is working autonomously", tone: "success", onClick: onOpenActivity },
    ])
  })

  it("does not count completed goals as active", () => {
    const autonomyStatus = {
      enabled: true,
      paused: false,
      in_flight: false,
      running_goals: [
        { id: 1, title: "Finished", status: "completed", progress: 100, run_id: null, started_at: null, last_progress_at: null },
      ],
    } as AutonomyStatus

    expect(build({ autonomyStatus }).map((status) => status.label)).toEqual([
      "Gateway connected",
      "Miki ready",
    ])
  })

  it("distinguishes a WebSocket error and an unknown gateway state", () => {
    expect(build({ connectionState: "error" })[0]).toEqual({
      label: "WebSocket error",
      tone: "warning",
      onClick: onOpenHealth,
    })
    expect(build({ gatewayState: "unknown" })[0]).toEqual({
      label: "Gateway status unknown",
      tone: "neutral",
      onClick: onOpenHealth,
    })
  })

  it("reports gateway lifecycle states", () => {
    expect(build({ gatewayState: "restarting" })[0]).toEqual({
      label: "Gateway restarting",
      tone: "info",
      onClick: onOpenHealth,
    })
    expect(build({ gatewayState: "error" })[0]).toEqual({
      label: "Gateway error",
      tone: "warning",
      onClick: onOpenHealth,
    })
  })
})
