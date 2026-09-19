#!/usr/bin/env node

// This file is a deterministic example for the bounded runtime-contract
// executor. It does not access the network, filesystem, shell, or secrets.
let input = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  input += chunk
})
process.stdin.on("end", () => {
  let payload = {}
  try {
    payload = JSON.parse(input || "{}")
  } catch {
    process.stderr.write("invalid JSON payload\n")
    process.exitCode = 2
    return
  }

  const message = typeof payload.message === "string"
    ? payload.message
    : "example-provider mock response"

  process.stdout.write(JSON.stringify({
    output: `Example Provider received: ${message}`,
  }))
})
