import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { BarChart } from '@pppp606/ink-chart';
import { useAsync } from '../hooks/use-async.js';
import { queryFeatureOverview, type FeatureOverview } from '../gcp/monitoring.js';
import { cache, CacheTTL } from '../gcp/cache.js';
import { formatNumber, formatPercent, truncate, type TimeRange, type Screen } from '../types.js';

interface OverviewScreenProps {
  projectId: string;
  timeRange: TimeRange;
  onNavigate: (screen: Screen) => void;
}

export function OverviewScreen({ projectId, timeRange, onNavigate }: OverviewScreenProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  const { data: features, loading, error } = useAsync(
    () =>
      cache.getOrFetch(
        `overview:${projectId}:${timeRange.preset}`,
        CacheTTL.METRICS,
        () => queryFeatureOverview(projectId, timeRange.startTime, timeRange.endTime)
      ),
    [projectId, timeRange.preset]
  );

  useInput((input, key) => {
    if (!features || features.length === 0) return;

    if (key.downArrow || input === 'j') {
      setSelectedIndex((i) => Math.min(i + 1, features.length - 1));
    }
    if (key.upArrow || input === 'k') {
      setSelectedIndex((i) => Math.max(i - 1, 0));
    }
    if (key.return) {
      const feature = features[selectedIndex];
      if (feature) onNavigate({ type: 'feature', featureName: feature.name });
    }
  });

  if (loading) {
    return (
      <Box>
        <Text color="cyan">
          <Spinner type="dots" />
        </Text>
        <Text> Loading metrics from Cloud Monitoring…</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box flexDirection="column">
        <Text color="red">✗ Error loading metrics:</Text>
        <Text color="red">{error}</Text>
        <Text dimColor>Press 'r' to retry</Text>
      </Box>
    );
  }

  if (!features || features.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="yellow">No features found in the selected time range.</Text>
        <Text dimColor>Try a longer time range with 't', or check that your Genkit app has the GCP plugin enabled.</Text>
      </Box>
    );
  }

  // Prepare bar chart data for requests
  const barData = features.slice(0, 10).map((f) => ({
    label: truncate(f.name, 22),
    value: f.totalRequests,
    color: f.successRate >= 0.95 ? '#3fb950' : f.successRate >= 0.5 ? '#d29922' : '#f85149',
  }));

  return (
    <Box flexDirection="column">
      {/* Request volume bar chart */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color="cyan">
          ── Requests by Feature ──
        </Text>
        <BarChart data={barData} showValue="right" sort="desc" />
      </Box>

      {/* Feature table */}
      <Box flexDirection="column">
        <Text bold color="cyan">
          ── Features ──
        </Text>
        <Box>
          <Box width={24}>
            <Text bold dimColor>
              Feature
            </Text>
          </Box>
          <Box width={8} justifyContent="flex-end">
            <Text bold dimColor>
              Reqs
            </Text>
          </Box>
          <Box width={10} justifyContent="flex-end">
            <Text bold dimColor>
              Success
            </Text>
          </Box>
          <Box width={12} justifyContent="flex-end">
            <Text bold dimColor>
              In Tokens
            </Text>
          </Box>
          <Box width={12} justifyContent="flex-end">
            <Text bold dimColor>
              Out Tokens
            </Text>
          </Box>
        </Box>
        <Text dimColor>{'─'.repeat(66)}</Text>

        {features.map((f, i) => (
          <FeatureRow
            key={f.name}
            feature={f}
            selected={i === selectedIndex}
          />
        ))}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>
          [↑↓] Navigate  [Enter] Detail  [t] Time range  [r] Refresh  [q] Quit
        </Text>
      </Box>
    </Box>
  );
}

function FeatureRow({ feature, selected }: { feature: FeatureOverview; selected: boolean }) {
  const successColor =
    feature.successRate >= 0.95 ? 'green' : feature.successRate >= 0.5 ? 'yellow' : 'red';
  const statusIcon = feature.successRate >= 0.95 ? '✓' : feature.successRate > 0 ? '⚠' : '●';

  return (
    <Box>
      <Box width={24}>
        <Text
          color={selected ? 'cyan' : undefined}
          bold={selected}
          inverse={selected}
        >
          {selected ? '▸ ' : '  '}
          {truncate(feature.name, 20)}
        </Text>
      </Box>
      <Box width={8} justifyContent="flex-end">
        <Text>{formatNumber(feature.totalRequests)}</Text>
      </Box>
      <Box width={10} justifyContent="flex-end">
        <Text color={successColor}>
          {statusIcon} {formatPercent(feature.successRate)}
        </Text>
      </Box>
      <Box width={12} justifyContent="flex-end">
        <Text color="blue">{formatNumber(feature.inputTokens)}</Text>
      </Box>
      <Box width={12} justifyContent="flex-end">
        <Text color="yellow">{formatNumber(feature.outputTokens)}</Text>
      </Box>
    </Box>
  );
}
