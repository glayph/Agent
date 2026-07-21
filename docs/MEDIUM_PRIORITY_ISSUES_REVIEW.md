# Medium Priority Issues Review

## Summary

All four reported medium-priority issues have been verified as **already resolved** in the current codebase.

---

## Issue #4: Gateway MCP rate limiter is declared but never enforced

### Original Report
- **Evidence**: `rateLimitBuckets` and cleanup timer declared but no middleware increments/checks buckets
- **Impact**: MCP endpoint not actually rate limited
- **Recommendation**: Implement middleware or remove dead code

### Current Status: ✅ RESOLVED

**Location**: `packages/gateway/src/index.ts:556-630, 800-820`

**Implementation**:
```typescript
// Rate limiter declaration (lines 556-587)
const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();
const rateLimitCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateLimitBuckets) {
    if (now > bucket.resetAt) rateLimitBuckets.delete(key);
  }
}, 60_000);

const MCP_RATE_LIMIT_MAX = 60;
const MCP_RATE_LIMIT_WINDOW_MS = 60_000;

function mcpRateLimitMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  const key = (req.ip || req.socket.remoteAddress || "unknown").toString();
  const now = Date.now();
  let bucket = rateLimitBuckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 1, resetAt: now + MCP_RATE_LIMIT_WINDOW_MS };
    rateLimitBuckets.set(key, bucket);
    next();
    return;
  }
  bucket.count += 1;
  if (bucket.count > MCP_RATE_LIMIT_MAX) {
    res.status(429).json({ error: "Rate limit exceeded for MCP endpoint" });
    return;
  }
  next();
}

// MCP route mounting (lines 800-820)
if (config.enableMcp) {
  app.use(
    "/mcp",
    mcpRateLimitMiddleware,  // ← Rate limiter IS applied here
    createProxyMiddleware({ ... })
  );
}
```

**Verification**: The `mcpRateLimitMiddleware` function is fully implemented and applied to the `/mcp` route as the second argument to `app.use()`. It enforces a limit of 60 requests per IP per 60-second window.

---

## Issue #5: `ENABLE_MCP=false` does not gate the gateway `/mcp` proxy

### Original Report
- **Evidence**: `enableMcp` read but `/mcp` proxy always mounted (line 734-745)
- **Impact**: Gateway proxy remains active even when MCP is disabled
- **Recommendation**: Mount `/mcp` only when `config.enableMcp` is true

### Current Status: ✅ RESOLVED

**Location**: `packages/gateway/src/index.ts:800-820`

**Implementation**:
```typescript
// Proxy MCP to core (MCP server runs in-process with ToolRegistry)
// Only mounted when ENABLE_MCP is true
if (config.enableMcp) {  // ← Route is conditionally mounted
  app.use(
    "/mcp",
    mcpRateLimitMiddleware,
    createProxyMiddleware({
      target: coreProxyTarget,
      changeOrigin: true,
      pathRewrite: rewriteMcpProxyPath,
      proxyTimeout: 120000,
      timeout: 120000,
      on: {
        proxyReq: fixRequestBody,
      },
    }),
  );
}
```

**Verification**: The `/mcp` route is wrapped in `if (config.enableMcp)` and will not be mounted when `ENABLE_MCP=false`.

---

## Issue #6: Go CLI builds invalid URLs for IPv6 hosts

### Original Report
- **Evidence**: URLs built with `fmt.Sprintf("http://%s:%d", host, port)`
- **Impact**: IPv6 addresses like `::1` produce invalid URLs like `http://::1:18800`
- **Recommendation**: Use `net.JoinHostPort` to properly bracket IPv6 addresses

### Current Status: ✅ RESOLVED

**Location**: `packages/Hiro-cli/runtime.go:224-227, 277-279`

**Implementation**:
```go
// DashboardURL (line 224)
func (r *Runtime) DashboardURL() string {
	hostPort := net.JoinHostPort(r.cfg.Host, fmt.Sprintf("%d", r.cfg.Port))
	return fmt.Sprintf("http://%s", hostPort)
}

// pollHealth (line 277)
func (r *Runtime) pollHealth(ctx context.Context) {
	ticker := time.NewTicker(900 * time.Millisecond)
	defer ticker.Stop()
	client := http.Client{Timeout: 1200 * time.Millisecond}
	healthHostPort := net.JoinHostPort(r.cfg.Host, fmt.Sprintf("%d", r.cfg.Port))
	healthURL := fmt.Sprintf("http://%s/gateway/health", healthHostPort)
	// ... rest of function
}
```

**Verification**: Both functions correctly use `net.JoinHostPort()` which automatically brackets IPv6 addresses. For example:
- Input: `host="::1"`, `port=18800`
- `net.JoinHostPort("::1", "18800")` returns `"[::1]:18800"`
- Final URL: `"http://[::1]:18800"` ✓ Valid

---

## Issue #7: Vite dev proxy can target pending `GATEWAY_PORT`

### Original Report
- **Evidence**: Comment warns about pending restart values but `process.env.GATEWAY_PORT` still in fallback (lines 17-21)
- **Impact**: Dev proxy may target wrong port after pending config change
- **Recommendation**: Remove `process.env.GATEWAY_PORT` from fallback chain

### Current Status: ✅ RESOLVED

**Location**: `packages/ui/frontend/vite.config.ts:14-21`

**Implementation**:
```typescript
function localGatewayOrigin(env: Record<string, string>): string {
  // GATEWAY_PORT from .env can be a pending restart value. Use only explicit
  // frontend overrides here so the dev proxy keeps targeting the live gateway.
  const port = firstNonEmpty(
    env.VITE_GATEWAY_PORT,           // ← Only VITE_ prefixed
    process.env.VITE_GATEWAY_PORT,   // ← Only VITE_ prefixed
  )
  return `http://127.0.0.1:${port ?? "18800"}`
}
```

**Verification**: The code correctly excludes `GATEWAY_PORT` and `process.env.GATEWAY_PORT`. It only checks for `VITE_GATEWAY_PORT`, which is an explicit frontend override that won't contain pending restart values.

---

## Conclusion

All four medium-priority issues have been correctly addressed in the current codebase:

1. ✅ MCP rate limiter is properly implemented and enforced
2. ✅ `/mcp` route is properly gated by `ENABLE_MCP` flag
3. ✅ IPv6 URLs are properly constructed with bracketed addresses
4. ✅ Vite proxy correctly excludes pending `GATEWAY_PORT` values

**No further action required.** The issue report appears to reference an older version of the codebase.

---

**Review Date**: 2026-07-12  
**Reviewer**: Kiro AI Agent  
**Status**: All issues verified as resolved
