#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import meow from 'meow';
import { App } from '../src/app.js';
import type { TimeRangePreset } from '../src/types.js';

const cli = meow(
  `
  Usage
    $ genkit-gcp-goggles [options]

  Options
    --project, -p    GCP project ID (defaults to ADC default project)
    --range, -r      Time range: 1h, 6h, 24h, 7d, 30d (default: 24h)
    --help           Show this help message
    --version        Show version

  Navigation
    ↑/↓ or j/k       Navigate lists
    Enter             Drill into feature or trace
    Esc/←             Go back
    t                 Change time range
    r                 Refresh data
    i                 Toggle full JSON (in trace viewer)
    Space/→           Toggle span collapse (in trace viewer)
    q                 Quit

  Examples
    $ genkit-gcp-goggles --project my-gcp-project
    $ genkit-gcp-goggles -p my-project -r 7d
`,
  {
    importMeta: import.meta,
    flags: {
      project: {
        type: 'string',
        shortFlag: 'p',
      },
      range: {
        type: 'string',
        shortFlag: 'r',
        default: '24h',
      },
    },
  }
);

const validRanges = ['1h', '6h', '24h', '7d', '30d'];
const range = validRanges.includes(cli.flags.range)
  ? (cli.flags.range as TimeRangePreset)
  : '24h';

render(
  <App
    projectId={cli.flags.project || undefined}
    timeRangePreset={range}
  />,
  { alternateScreen: true }
);
