# 🔍 genkit-gcp-goggles

A terminal-based dashboard for viewing Genkit production telemetry from Google Cloud Monitoring and Cloud Trace. Built with [Ink](https://github.com/vadimdemedes/ink) (React for CLIs) and [@pppp606/ink-chart](https://github.com/pppp606/ink-chart).

## Features

- **Overview**: See all Genkit features with request counts, success rates, and token usage with bar charts
- **Feature Detail**: Drill into a feature to see token usage charts and recent traces
- **Trace Viewer**: Inspect individual traces with a collapsible span tree and span detail panel showing input/output data
- **Keyboard-driven**: vim-style navigation (j/k), drill-in/out, time range picker

## Prerequisites

1. **Node.js 18+** and **pnpm** (or npm)
2. **Google Cloud SDK** (`gcloud`) installed
3. A GCP project with Genkit telemetry data

## Setup

### 1. Authenticate with GCP

```bash
gcloud auth application-default login
```

### 2. Install dependencies

```bash
pnpm install
```

### 3. Run

```bash
pnpm start
# or with options:
pnpm start -- --project my-gcp-project --range 7d
```

## Usage

```
$ genkit-gcp-goggles [options]

Options
  --project, -p    GCP project ID (defaults to ADC default project)
  --range, -r      Time range: 1h, 6h, 24h, 7d, 30d (default: 24h)
  --help           Show help
  --version        Show version
```

### Navigation

| Key | Action |
|-----|--------|
| `↑`/`↓` or `j`/`k` | Navigate lists |
| `Enter` | Drill into feature or trace |
| `Esc`/`←` | Go back |
| `t` | Change time range |
| `r` | Refresh data (clears cache) |
| `i` | Toggle full JSON view (trace viewer) |
| `Space`/`→` | Toggle span collapse (trace viewer) |
| `q` | Quit |

### Screens

1. **Overview** — Feature table with bar chart, success rates, token counts
2. **Feature Detail** — Per-feature stats, token usage chart, traces list
3. **Trace Viewer** — Split view with collapsible span tree (left) and span detail (right)

## Architecture

```
Terminal (Ink + React)  →  GCP APIs (direct, via ADC)
  @pppp606/ink-chart         Cloud Monitoring v3
  Keyboard navigation        Cloud Trace v1
  In-memory LRU cache
```

No backend server needed — the CLI authenticates directly using Application Default Credentials and calls GCP APIs. Responses are cached in-memory (metrics: 60s, traces: 30s, individual traces: 5min).

## GCP APIs Used

- **Cloud Monitoring v3** — Feature request counts, latency, token usage metrics
- **Cloud Trace v1** — Trace listing and span detail (v1 is the read API; v2 is write-only)

All access is **read-only** (scopes: `monitoring.read`, `trace.readonly`).
