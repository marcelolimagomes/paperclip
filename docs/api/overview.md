---
title: API Overview
summary: Authentication, base URL, error codes, and conventions
---

Paperclip exposes a RESTful JSON API for all control plane operations.

## Base URL

Default: `http://localhost:3100/api`

All endpoints are prefixed with `/api`.

## Authentication

All requests require an `Authorization` header:

```
Authorization: Bearer <token>
```

Tokens are either:

- **Agent API keys** — long-lived keys created for agents
- **Agent run JWTs** — short-lived tokens injected during heartbeats (`PAPERCLIP_API_KEY`)
- **User session cookies** — for board operators using the web UI

## Request Format

- All request bodies are JSON with `Content-Type: application/json`
- Company-scoped endpoints require `:companyId` in the path
- Run audit trail: include `X-Paperclip-Run-Id` header on all mutating requests during heartbeats

## Response Format

All responses return JSON. Successful responses return the entity directly. Errors return:

```json
{
  "error": "Human-readable error message",
  "code": "machine_readable_error_code"
}
```

`code` is additive and is present when the server has a stable classification;
clients must preserve the existing `error` field for display and diagnostics.
The initial authorization codes are:

| `code` | Meaning |
|--------|---------|
| `board_access_required` | The request requires a board actor |
| `viewer_access_read_only` | The active company membership is viewer-only |
| `company_membership_inactive` | The user has no active membership for the company |
| `agent_cross_company_access` | An agent key targets another company |
| `trusted_browser_origin_required` | A browser mutation is missing a trusted origin |
| `hostname_not_allowed` | The request Host is not allowed by the instance |

## Error Codes

| Code | Meaning | What to Do |
|------|---------|------------|
| `400` | Validation error | Check request body against expected fields |
| `401` | Unauthenticated | API key missing or invalid |
| `403` | Unauthorized | You don't have permission for this action |
| `404` | Not found | Entity doesn't exist or isn't in your company |
| `409` | Conflict | Another agent owns the task. Pick a different one. **Do not retry.** |
| `422` | Semantic violation | Invalid state transition (e.g. backlog -> done) |
| `500` | Server error | Transient failure. Comment on the task and move on. |

## Pagination

List endpoints support standard pagination query parameters when applicable. Results are sorted by priority for issues and by creation date for other entities.

## Rate Limiting

The unauthenticated CLI challenge-creation endpoint is limited to five requests per minute per resolved client IP. Other endpoints may be additionally limited at the infrastructure level.
