# Agentia Env Drift

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node 18+](https://img.shields.io/badge/node-%3E%3D18-blue.svg)](package.json)
[![Agentia 0.122](https://img.shields.io/badge/agentia-0.122.0--alpha.1-blue.svg)](https://developer.copado.com/docs)

**Env Drift** catches the changes made directly in target orgs before
they break your deployment. Fetch both ends, diff locally, and
optionally hear the impact explained.

Read only on both orgs. Built for the **Agentia Headless Virtual
Hackathon** as an oclif plugin on top of the public `agentia` CLI.

---

## Table of Contents

- [The Problem](#the-problem)
- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Live Demo Workflow](#live-demo-workflow)
- [Command Reference](#command-reference)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [How It Works](#how-it-works)
- [Security](#security)
- [Tech Stack](#tech-stack)
- [Architecture](#architecture)
- [Hackathon Fit](#hackathon-fit)
- [License](#license)

---

## The Problem

Deployments fail in UAT that passed in dev because someone edited
metadata directly in the target org. Finding that drift in XML diffs
takes hours of manual comparison, and the failure always lands at the
worst moment.

## Features

- **Two end fetching** — content retrieved per side with independent
  credential plus org pairs.
- **Local deterministic diff** — multiset line comparison with added
  plus removed counts and capped hunks, no prompt involved.
- **Opt-in AI explanation** — `--ai-explain` asks the operate agent
  about deployment impact on capped diff text. Off by default.
- **Identical fast path** — equal content short circuits with a clear
  safe to proceed message.
- **Honest fetch failures** — each side reports separately so slow or
  missing ends are diagnosable.
- **Zero private imports** — only shells out to public `agentia`
  commands.

## Installation

### Prerequisites

- Node 18 or newer.
- Agentia CLI beta: `npm install -g @copado/agentia-cli@beta`
- Authenticated machine plus credential IDs for both ends.

### Install from source

```sh
git clone https://github.com/devkdas/agentia-env-drift.git
cd agentia-env-drift
npm install
npm run build
agentia plugins link .
```

Re-run `npm run build` after every change to the TypeScript files.

## Quick Start

### 1. Compare one member across two orgs

```sh
agentia drift check --type ApexClass --name AccountHelper \
  --source-credential-id a11 --source-org-id 00D \
  --target-credential-id a22 --target-org-id 00E
```

### 2. Add the AI impact explanation

```sh
agentia drift check --type ApexClass --name AccountHelper \
  --source-credential-id a11 --source-org-id 00D \
  --target-credential-id a22 --target-org-id 00E --ai-explain --json
```

## Live Demo Workflow

Verified live:

```text
1. Bad credentials on one end -> honest per-side fetch failure
2. Same end both sides -> identical fast path (endpoint dependent)
3. AI explanation path shares the proven ask pattern with capped input
```

Note: the content endpoint can be slow for large members. Fetch errors
name the failing side so retries target correctly.

## Command Reference

### `agentia drift check`

| Flag | Description |
|---|---|
| `-t, --type <type>` | Metadata type, for example ApexClass (required) |
| `-n, --name <name>` | Metadata API name (required) |
| `--source-credential-id` | Source org credential ID (required) |
| `--source-org-id` | Source org ID (required) |
| `--target-credential-id` | Target org credential ID (required) |
| `--target-org-id` | Target org ID (required) |
| `--pipeline-id` | Pipeline ID scoping gateway calls |
| `--ai-explain` | Operate agent impact explanation, off by default |
| `-j, --json` | Machine readable JSON output |

### `agentia drift sync`

| Flag | Description |
|---|---|
| Same scope flags as check | Both ends plus optional pipeline |
| `--direction source\|target` | Declared winning side for the plan |
| `-y, --yes` | Reveal the apply runbook |
| `--ai-explain` | Operate agent plan narration, off by default |
| `--json` | Machine readable JSON output |

Sync proposes the plan and reveals operator run steps only after an
explicit direction plus confirmation. Application itself always stays
operator run since no write primitive is claimed.

## Configuration

Credential plus org pairs per end, optional pipeline scope. AI calls
carry their own timeout and degrade to null without failing the report.

## Troubleshooting

| Problem | Likely cause | Fix |
|---|---|---|
| Source or target fetch failed | Wrong IDs or slow endpoint | Check IDs, retry, narrow the member |
| Empty comparable content | Endpoint returned no payload | Verify the member exists on that end |
| AI explanation null | Agent unreachable | Raw diff still stands, retry later |
| ESM auto-transpile warning | Linked ESM plugin notice | Benign, compiled output is used |

## How It Works

```text
agentia drift check
  -> content get per end (independent credential pairs)
  -> local multiset line diff with capped hunks
  -> ai agent ask --agent operate (opt-in, capped input)
  -> identical / drifted verdict plus JSON
```

## Security

Read only on both orgs by design. No writes, no tokens printed. AI
input is capped so prompt sizes stay bounded.

## Tech Stack

| Layer | Technology |
|---|---|
| Language | TypeScript on Node 18+ |
| CLI Framework | oclif v4 (ESM, matching the host CLI) |
| Runtime calls | `node:child_process` to public `agentia` commands |

## Architecture

```text
Developer / Agent
       |
agentia drift check --type --name (two credential pairs)
       |
Env Drift (this plugin)
  |- fetcher  -> content get per end
  |- differ   -> local multiset line diff
  |- explainer -> operate agent (opt-in)
       |
Verdict plus hunks plus JSON
```

## Hackathon Fit

Automates the most hated debugging session in Salesforce DevOps,
improves reliability before promotion instead of after failure, and
reuses the proven native AI pattern with strict input caps.

## License

MIT License — see [LICENSE](LICENSE) for details.
