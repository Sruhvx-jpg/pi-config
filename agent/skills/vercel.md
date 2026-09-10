---
name: vercel
description: Vercel & Next.js ecosystem guidance (AI SDK, Next.js App Router, flags, auth, caching, deployments, CLI, functions). Canonical upstream pointer to vercel/vercel-plugin.
---

# Vercel & Next.js Ecosystem Skills (Upstream Pointer)

- **Canonical Repository**: `https://github.com/vercel/vercel-plugin/tree/main/skills`
- **Raw Base URL**: `https://raw.githubusercontent.com/vercel/vercel-plugin/main/skills`

Skills are resolved dynamically from upstream on-demand rather than vendoring duplicate text locally. When deep guidance on a specific topic is needed, read directly via:
```bash
curl -sL https://raw.githubusercontent.com/vercel/vercel-plugin/main/skills/<topic>/SKILL.md
```

## Capability Index

| Topic | Description | Upstream Target |
|---|---|---|
| `ai-sdk` | AI SDK core, streaming, tool calling, structured outputs, agents | `skills/ai-sdk/SKILL.md` |
| `ai-gateway` | Model routing, provider failover, cost tracking, unified AI API | `skills/ai-gateway/SKILL.md` |
| `nextjs` | Next.js App Router, Server Components, Route Handlers, SSR/SSG | `skills/nextjs/SKILL.md` |
| `next-cache-components` | Next.js 16 cache directives, PPR, use cache, cacheLife | `skills/next-cache-components/SKILL.md` |
| `next-forge` | Production Turborepo monorepo SaaS starter by Vercel | `skills/next-forge/SKILL.md` |
| `next-upgrade` | Version migration guides, official codemods | `skills/next-upgrade/SKILL.md` |
| `react-best-practices` | React 19 quality checklist, hooks, re-renders, performance | `skills/react-best-practices/SKILL.md` |
| `shadcn` | UI component CLI, registries, theming, Tailwind integration | `skills/shadcn/SKILL.md` |
| `turbopack` | Bundler optimization, HMR, webpack migration | `skills/turbopack/SKILL.md` |
| `vercel-cli` | Deployment inspection, linking, environment variables, domains | `skills/vercel-cli/SKILL.md` |
| `vercel-functions` | Serverless, Edge, Fluid Compute, streaming, cron jobs | `skills/vercel-functions/SKILL.md` |
| `vercel-storage` | Blob storage, Edge Config, Neon Postgres, Upstash Redis | `skills/vercel-storage/SKILL.md` |
| `vercel-firewall` | WAF custom rules, rate limiting, attack mode, DDoS defense | `skills/vercel-firewall/SKILL.md` |
| `workflow` | Durable workflows, long-running tasks, pause/resume | `skills/workflow/SKILL.md` |
| `chat-sdk` | Multi-platform chat bots (Slack, Teams, Discord, Linear) | `skills/chat-sdk/SKILL.md` |
| `auth` | Clerk, Descope, Auth0 middleware & marketplace patterns | `skills/auth/SKILL.md` |
| `flags-sdk` | Feature flags, adapters, precompute static A/B testing | `skills/flags-sdk/SKILL.md` |
| `microfrontends` | Multi-zones, path-based routing, microfrontends.json | `skills/microfrontends/SKILL.md` |
| `cdn-caching` | CDN cache debugging, revalidation, ISR, cache reasons | `skills/cdn-caching/SKILL.md` |
| `routing-middleware` | Request interception before cache, rewrites, redirects | `skills/routing-middleware/SKILL.md` |
| `runtime-cache` | Ephemeral per-region key-value cache API | `skills/runtime-cache/SKILL.md` |
| `vercel-sandbox` | Ephemeral Firecracker microVMs for untrusted code | `skills/vercel-sandbox/SKILL.md` |
| `create-a-backend` | Backend architecture guidance, Functions vs Services | `skills/create-a-backend/SKILL.md` |
| `deployments-cicd` | Deploying, promoting, rollbacks, --prebuilt, CI/CD | `skills/deployments-cicd/SKILL.md` |
| `env-vars` | .env files, vercel env, OIDC tokens | `skills/env-vars/SKILL.md` |
| `marketplace` | Third-party integrations discovery via vercel integration CLI | `skills/marketplace/SKILL.md` |
| `verification` | Full-story end-to-end verification (browser -> API -> DB) | `skills/verification/SKILL.md` |
| `access-protected-vercel-deployment` | Bypass Vercel auth & SSO on previews via tokens | `skills/access-protected-vercel-deployment/SKILL.md` |
| `bootstrap` | Linked resources setup orchestrator | `skills/bootstrap/SKILL.md` |
| `build-agents` | Generic AI agent architecture | `skills/build-agents/SKILL.md` |
| `eve` | Filesystem-first durable agent framework | `skills/eve/SKILL.md` |
| `knowledge-update` | Corrections to outdated LLM knowledge | `skills/knowledge-update/SKILL.md` |
| `vercel-agent` | AI code review & incident investigation | `skills/vercel-agent/SKILL.md` |
| `vercel-connect` | Scoped OAuth tokens & MCP server connections | `skills/vercel-connect/SKILL.md` |
| `vercel-services` | Polyglot multi-frontend/backend services composition | `skills/vercel-services/SKILL.md` |
