import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { LineGraph, Sparkline } from '@pppp606/ink-chart';
import { useAsync } from '../hooks/use-async.js';
import {
  queryFeatureOverview,
  queryOverviewTimeSeries,
  type FeatureOverview,
} from '../gcp/monitoring.js';
import { cache, CacheTTL } from '../gcp/cache.js';
import { ErrorDisplay } from '../components/error-display.js';
import {
  formatNumber,
  formatPercent,
  formatDuration,
  truncate,
  type TimeRange,
  type Screen,
} from '../types.js';

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

  const { data: timeSeries } = useAsync(
    () =>
      cache.getOrFetch(
        `overview-ts:${projectId}:${timeRange.preset}`,
        CacheTTL.METRICS,
        () => queryOverviewTimeSeries(projectId, timeRange.startTime, timeRange.endTime)
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
      <ErrorDisplay error={error} context="metrics" showRetry={true} />
    );
  }

  if (!features || features.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="yellow">No features found in the selected time range.</Text>
        <Text dimColor>
          Try a longer time range with 't', or check that your Genkit app has the GCP plugin
          enabled.
        </Text>
      </Box>
    );
  }

  // Prepare time-series x-axis labels
  const makeXLabels = (points: Array<{ time: string }>): string[] => {
    if (points.length < 2) return [];
    const first = new Date(points[0].time);
    const last = new Date(points[points.length - 1].time);
    const fmtTime = (d: Date) => {
      const h = d.getHours();
      const m = d.getMinutes().toString().padStart(2, '0');
      const ampm = h >= 12 ? 'PM' : 'AM';
      const h12 = h % 12 || 12;
      return `${h12}:${m}${ampm}`;
    };
    return [fmtTime(first), fmtTime(last)];
  };

  const successReqValues = timeSeries?.successRequests.map((p) => p.value) || [];
  const failureReqValues = timeSeries?.failureRequests.map((p) => p.value) || [];
  const successValues = timeSeries?.successRate.map((p) => p.value) || [];
  const latencyValues = timeSeries?.latencyP95.map((p) => p.value) || [];
  const requestXLabels = timeSeries?.requests ? makeXLabels(timeSeries.requests) : [];
  const hasAnyFailure = failureReqValues.some((v) => v > 0);

  return (
    <Box flexDirection="column">
      {/* Time-series charts row */}
      {timeSeries && (successReqValues.length > 1 || successValues.length > 1) && (
        <Box marginBottom={1}>
          {/* Requests chart */}
          <Box flexDirection="column" marginRight={2} width="33%">
            <Box gap={1}>
              <Text bold color="cyan">
                REQUESTS
              </Text>
              <Text bold color="white">
                {formatNumber(timeSeries.totalRequestCount)}
              </Text>
            </Box>
            {successReqValues.length > 1 ? (
              <LineGraph
                data={[
                  { values: successReqValues, color: '#3fb950' },
                  ...(hasAnyFailure
                    ? [{ values: failureReqValues, color: '#f85149' }]
                    : []),
                ]}
                height={5}
                width={24}
                showYAxis={true}
                xLabels={requestXLabels}
              />
            ) : (
              <Text dimColor>No data</Text>
            )}
          </Box>

          {/* Success rate chart */}
          <Box flexDirection="column" marginRight={2} width="33%">
            <Box gap={1}>
              <Text bold color="cyan">
                SUCCESS RATE
              </Text>
              <Text
                bold
                color={
                  timeSeries.overallSuccessRate >= 95
                    ? 'green'
                    : timeSeries.overallSuccessRate >= 50
                      ? 'yellow'
                      : 'red'
                }
              >
                {timeSeries.overallSuccessRate.toFixed(1)}%
              </Text>
            </Box>
            {successValues.length > 1 ? (
              <LineGraph
                data={[{ values: successValues, color: '#3fb950' }]}
                height={5}
                width={24}
                showYAxis={true}
                yDomain={[0, 100] as [number, number]}
                yLabels={['0%', '50%', '100%']}
              />
            ) : (
              <Text dimColor>No data</Text>
            )}
          </Box>

          {/* Latency chart */}
          <Box flexDirection="column" width="33%">
            <Box gap={1}>
              <Text bold color="cyan">
                LATENCY (P95)
              </Text>
              {timeSeries.latencyP95Value != null ? (
                <Text bold color="white">
                  {formatDuration(timeSeries.latencyP95Value)}
                </Text>
              ) : null}
            </Box>
            {latencyValues.length > 1 ? (
              <LineGraph
                data={[{ values: latencyValues, color: '#58a6ff' }]}
                height={5}
                width={24}
                showYAxis={true}
              />
            ) : (
              <Text dimColor>No data</Text>
            )}
          </Box>
        </Box>
      )}

      {/* Feature table */}
      <Box flexDirection="column">
        <Text bold dimColor>
          FEATURES
        </Text>
        {/* Table header */}
        <Box>
          <Box width={20}>
            <Text bold dimColor>
              Feature
            </Text>
          </Box>
          <Box width={10} justifyContent="flex-end">
            <Text bold dimColor>
              Success
            </Text>
          </Box>
          <Box width={16} justifyContent="flex-end">
            <Text bold dimColor>
              Requests
            </Text>
          </Box>
          <Box width={12}>
            <Text bold dimColor>
              {'  '}Trend
            </Text>
          </Box>
          <Box width={10} justifyContent="flex-end">
            <Text bold dimColor>
              Latency
            </Text>
          </Box>
          <Box width={10} justifyContent="flex-end">
            <Text bold dimColor>
              In Tok
            </Text>
          </Box>
          <Box width={10} justifyContent="flex-end">
            <Text bold dimColor>
              Out Tok
            </Text>
          </Box>
        </Box>
        <Text dimColor>{'─'.repeat(88)}</Text>

        {features.map((f, i) => (
          <FeatureRow key={f.name} feature={f} selected={i === selectedIndex} />
        ))}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>
          [↑↓] Navigate [Enter] Detail [t] Time range [r] Refresh [q] Quit
        </Text>
      </Box>
    </Box>
  );
}

function FeatureRow({
  feature,
  selected,
}: {
  feature: FeatureOverview;
  selected: boolean;
}) {
  const successColor =
    feature.successRate >= 0.95 ? 'green' : feature.successRate >= 0.5 ? 'yellow' : 'red';
  const dotColor =
    feature.successRate >= 0.95 ? 'green' : feature.successRate >= 0.5 ? 'yellow' : 'red';

  // Format requests with failure count
  const reqStr = String(feature.totalRequests);
  const failStr =
    feature.failureCount > 0 ? ` (${feature.failureCount} failed)` : '';

  return (
    <Box>
      <Box width={20}>
        <Text
          color={selected ? 'cyan' : dotColor}
          bold={selected}
          inverse={selected}
        >
          {selected ? '▸ ' : '● '}
          {truncate(feature.name, 17)}
        </Text>
      </Box>
      <Box width={10} justifyContent="flex-end">
        <Text color={successColor}>{formatPercent(feature.successRate)}</Text>
      </Box>
      <Box width={16} justifyContent="flex-end">
        <Text>{reqStr}</Text>
        {feature.failureCount > 0 && (
          <Text color="red">{failStr}</Text>
        )}
      </Box>
      <Box width={12}>
        <Text>  </Text>
        {feature.requestSeries.length > 2 ? (
          <Sparkline data={feature.requestSeries} width={8} />
        ) : (
          <Text dimColor>{'─'.repeat(8)}</Text>
        )}
      </Box>
      <Box width={10} justifyContent="flex-end">
        <Text>
          {feature.latencyP95Ms != null ? formatDuration(feature.latencyP95Ms) : '—'}
        </Text>
      </Box>
      <Box width={10} justifyContent="flex-end">
        <Text color="blue">{formatNumber(feature.inputTokens)}</Text>
      </Box>
      <Box width={10} justifyContent="flex-end">
        <Text color="yellow">{formatNumber(feature.outputTokens)}</Text>
      </Box>
    </Box>
  );
}
