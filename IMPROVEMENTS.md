# Pi Configuration Efficiency Improvements

This document lists recommended functionality and optimizations that could be added to the Pi configuration to improve efficiency and performance.

---

> **⚠️ Network Isolation Note:**
> Pi runs in a sandboxed container on an internal Docker network (no internet access).
> This means cloud-based models (e.g., `gpt-4o-mini`) are not available without modifying
> the network isolation. The current `.env` uses only local models via Ollama, which aligns
> with Pi's core security principle of network isolation.

---

## 1. Model Selection Strategy (Task-based Model Routing)

**CURRENT STATUS:**
- **Primary model in `.env`:** `"qwen3.5:9b"` (local-only via Ollama)
- **Embedding model:** `"nomic-embed-text"` (local-only)
- **No cloud models configured** - Pi runs entirely on a local Ollama instance

**RECOMMENDATION:**
- ✅ **Keep as-is** - The current single-model setup is appropriate for a local-only environment.
- Cloud models (e.g., `gpt-4o-mini`) add latency, cost, and require network access
- Your sandboxed Pi design explicitly blocks internet
- Adding a cloud model would break Pi's core security principle of network isolation

**ALTERNATIVE (If Cloud Access is Needed):**
- Create a separate `PI_MODELS.local` environment for local-only ops
- Add conditional logic in Pi to select `gpt-4o-mini"` only when `NO_CLOUD=false`

**CONCLUSION:**
No change needed - the current local-only setup aligns with Pi's sandboxed design.

---

## 2. Prompt & Context Optimization

Reduce context window usage and eliminate redundant communications.

```yaml
context_management:
  max_context_window: 16000     # Reduce waste from unused tokens
  summary_before_tool: true      # Summarize previous tool output
  skip_redundant_messages: true  # Drop duplicate user/agent patterns
```

---

## 3. MCP Tool Caching

Cache tool responses to avoid repeating the same queries.

```typescript
// In mcp-memory server
response_cache: {
  ttl_seconds: 300,             // Cache lookup_docs results for 5 min
  exact_match: true,            // Cache identical queries
  similarity_threshold: 0.85    // Cache semantically similar
}
```

---

## 4. Chunking Strategy Optimization

Adjust chunking parameters for better retrieval relevance.

```yaml
// In ingest config
chunking:
  max_size_kb: 50               # Smaller chunks for better relevance
  overlap: 15%                  # Better context for multi-step reasoning
  vector_dimension: "default"   # Optimize for your embedding model
```

---

## 5. Connection Pooling & Health Checks

Add health checks and prevent hanging requests.

```yaml
// In docker-compose.yml
services:
  mcp-memory:
    healthcheck:
      test: ["CMD", "node", "-e", "require('http')"]
      interval: 10s
      timeout: 5s
      retries: 3
```

---

## 6. Lazy Document Loading

Don't preload all docs; load only relevant chunks to prevent query overflow.

```yaml
vector_search:
  lazy: true
  max_retrieval_per_task: 5     # Prevent query overflow
```

---

## 7. Background Indexing

Automate re-indexing new documentation without requiring manual intervention.

```bash
# Add to pi/agent/scripts
# Re-index new docs without waiting for user prompt
cron_job: "0 */6 * * * /ingest/yarn ingest:reference"  # Every 6 hours
```

---

## 8. Rate Limiting & Throttling

Prevent Ollama overload by limiting concurrent requests.

```yaml
requests:
  max_concurrent: 2             # Prevent Ollama overload
  timeout_seconds: 30
  retry_attempts: 2
```

---

## 9. Response Summarization (Token Reduction)

Reduce token usage by summarizing very long responses when they exceed a threshold.

```yaml
// In Pi prompt configuration
response_handling:
  max_tokens_per_response: 2048   # Truncate to this limit
  summarize_long_output: true      # Summarize responses that need to be shortened
  max_summary_length: 500          # Cap summaries to this many tokens
```

---

## 10. Session Recovery

Automate session cleanup and restore previous context on restart.

```yaml
sessions:
  max_history_days: 7
  cleanup_after: 24             # Archive old sessions
  restore_on_restart: true      # Re-attach to previous context
```

---

## Immediate Wins (Easiest to Implement)

These optimizations can be added quickly with minimal overhead:

1. **MCP response caching** - Saves repeated API calls to the same tools
2. **Reduce max_context_window** - Reduce waste from unused tokens
3. **Add health checks** - Prevent hanging requests
4. **Set reasonable timeouts** - 30s instead of 60s+ for most operations
5. **Limit concurrent requests** - Prevent Ollama overload
6. **Response summarization** - Summarize responses above token limits to save tokens

---

## Implementation Priority

| Priority | Improvement | Effort | Expected Impact |
|----------|-------------|--------|-----------------|
| High | MCP Tool Caching | Low | Significant |
| High | Rate Limiting | Low | Moderate |
| High | Health Checks | Low | Moderate |
| Medium | Prompt Optimization | Medium | Moderate |
| Medium | Chunking Strategy | Low | Low-Moderate |
| Medium | Response Compression | Medium | Moderate |
| Low | Background Indexing | Medium | Low |
| Low | Session Recovery | Medium | Low |

---

*Last updated: 2026-10-16*
