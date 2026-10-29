import { webhookAuthorized, webhookEventName, webhookSecret } from "./webhook-ingress.js"

describe("webhook ingress", () => {
  it("is disabled without a secret and prefers the environment secret", () => {
    expect(webhookSecret({}, {})).toBe("")
    expect(webhookSecret({ autonomy: { webhooks: { secret: " cfg " } } }, {})).toBe("cfg")
    expect(webhookSecret({ autonomy: { webhooks: { secret: "cfg" } } }, { MIKI_WEBHOOK_SECRET: "env" })).toBe("env")
  })
  it("accepts only the exact secret via Bearer or X-Miki-Webhook-Secret", () => {
    expect(webhookAuthorized("s3cret", { authorization: "Bearer s3cret" })).toBe(true)
    expect(webhookAuthorized("s3cret", { "x-miki-webhook-secret": "s3cret" })).toBe(true)
    expect(webhookAuthorized("s3cret", { authorization: "Bearer nope" })).toBe(false)
    expect(webhookAuthorized("s3cret", {})).toBe(false)
    expect(webhookAuthorized("", { authorization: "Bearer " })).toBe(false)
  })
  it("namespaces and validates event names", () => {
    expect(webhookEventName("deploy.finished")).toBe("webhook:deploy.finished")
    expect(webhookEventName("../x")).toBeNull()
    expect(webhookEventName("")).toBeNull()
    expect(webhookEventName("a".repeat(81))).toBeNull()
  })
})
