# Agent Ledger

Proof of what your AI agents did, and who approved it.

[![Watch the 78-second demo](docs/media/demo-poster.png)](docs/media/agent-ledger-demo.mp4)

*Click the image to watch the demo (78 s). Final scenes use real output from a live home-lab run on 2026-10-05.*

## What it does

AI coding agents (Claude Code, Codex, MCP clients) now run commands, change infrastructure and touch production.
Agent Ledger sits between the agent and its tools:

1. **Checks every tool call** against a tool registry your team reviewed: read tools are allowed, reviewed write tools
   are allowed and recorded, risky tools need a named person, and anything unreviewed is denied.
2. **Asks a named approver in Slack** before a risky call runs. Timeouts, outages and unknown approvers all mean deny.
3. **Writes every decision first** to a tamper-evident, hash-chained ledger (local file or Postgres with append-only
   enforced by the database), then lets the tool run and records the outcome.
4. **Keeps secrets out of the ledger**: arguments not on a tool's allowlist are stored only as keyed HMAC fingerprints.
5. **Exports SOC 2 evidence** (HTML, PDF, CSV) mapped to CC6.1, CC7.2 and CC8.1, verified against an anchor kept off
   the machine, with the trust boundary stated on the cover.

## Two deployment modes

| Mode | How calls are collected | What the evidence proves |
|---|---|---|
| Local | Hooks inside Claude Code / Codex behind a fail-closed two-process watchdog | Visibility and best-effort gating; the machine owner could remove hooks, and the pack says so |
| Server | Agents connect to the Agent Ledger MCP proxy (TLS), which holds the tool credentials | Enforcement: the agent cannot reach the tool except through the proxy |

## Status

Pre-release, private. Server mode has run end to end in a hardened Kubernetes lab (Pod Security restricted,
default-deny NetworkPolicies, Kyverno admission policy, Falco runtime rules) with live Slack approvals.
A customer install guide and packaged images are the next slice.

## Repository map

| Path | What |
|---|---|
| `src/` | hooks + watchdog, pipeline, policy, identity, ledger, approvals (Slack), front/upstream (MCP proxy), report, CLI, server |
| `deploy/` | Dockerfile, Kubernetes manifests (kustomize), SQL roles and triggers, Falco rules, Slack app manifest |
| `docs/spec.md` | Frozen framework spec (trust boundary in §3 and §7) |
| `docs/DEMO.md` | Local-mode demo script |
| `docs/HOMELAB.md` | Server-mode deployment runbook (home-lab Kubernetes) |
| `DESIGN.md` | Visual design system for the evidence pack and future UI |
| `docs/reviews/`, `docs/slices/` | Cross-review reports and per-slice interface pins |

## Development

```sh
npm ci
npm run check      # typecheck + unit + timing tests + build
```

Built by a two-engine agent team (Claude and Codex) under a build → independent cross-review → fix → verify loop;
every merge is approved by a human.
