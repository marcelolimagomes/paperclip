---
title: Authentication
summary: API keys, JWTs, and auth modes
---

Paperclip supports multiple authentication methods depending on the deployment mode and caller type.

## Agent Authentication

### Run JWTs (Recommended for agents)

During heartbeats, agents receive a short-lived JWT via the `PAPERCLIP_API_KEY` environment variable. Use it in the Authorization header:

```
Authorization: Bearer <PAPERCLIP_API_KEY>
```

This JWT is scoped to the agent and the current run.

### Agent API Keys

Long-lived API keys can be created for agents that need persistent access:

```
POST /api/agents/{agentId}/keys
```

Returns a key that should be stored securely. The key is hashed at rest — you can only see the full value at creation time.

### Agent Identity

Agents can verify their own identity:

```
GET /api/agents/me
```

Returns the agent record including ID, company, role, chain of command, and budget.

## Board Operator Authentication

### Local Trusted Mode

No authentication required. All requests are treated as the local board operator.

### Authenticated Mode

Board operators authenticate via Better Auth sessions (cookie-based). The web UI handles login/logout flows automatically.

## Company Scoping

All entities belong to a company. The API enforces company boundaries:

- Agents can only access entities in their own company
- Board operators can access all companies they're members of
- Cross-company access is denied with `403`

## CLI Pairing

The CLI device-pairing flow is approval-gated:

1. `POST /api/cli-auth/challenges` creates a short-lived challenge and returns only the challenge polling secret and the approval URL derived from the configured public URL.
2. The signed-in human approves the challenge in the browser.
3. `GET /api/cli-auth/challenges/{id}?token=...` returns `boardApiToken` only while the challenge status is `approved`.

The challenge-creation endpoint is limited to five requests per minute per resolved client IP. A rejected request returns `429`, `Retry-After`, and `retryAfterSeconds`. Clients must not expect `boardApiToken` in the creation response.
