import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { BarChart } from '@pppp606/ink-chart';
import { useAsync } from '../hooks/use-async.js';
import { queryFeatureOverview } from '../gcp/monitoring.js';
import { listTraces, normalizeTraceForList, type TraceListItem } from '../gcp/tracing.js';
import { cache, CacheTTL } from '../gcp/cache.js';
import {
  formatNumber, formatPercent, formatDuration, formatTime, truncate,
  type TimeRange, type Screen,
} from '../types.js';

interface FeatureDetailProps {
  projectId: string;
  featureName: string;
  timeRange: TimeRange;
  onNavigate: (screen: Screen) => void;
}

export function FeatureDetailScreen({ projectId, featureName, timeRange, onNavigate }: FeatureDetailProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Fetch feature metrics
  const { data: features } = useAsync(
    () =>
      cache.getOrFetch(
        `overview:${projectId}:${timeRange.preset}`,
        CacheTTL.METRICS,
        () => queryFeatureOverview(projectId, timeRange.startTime, timeRange.endTime)
      ),
    [projectId, timeRange.preset]
  );

  const feature = features?.find((f) => f.name === featureName) || null;

  // Fetch traces for this feature
  const { data: tracesData, loading: tracesLoading, error: tracesError } = useAsync(
    () =>
      cache.getOrFetch(
        `traces:${projectId}:${featureName}:${timeRange.preset}`,
        CacheTTL.TRACE_LIST,
        async () => {
          const { traces: rawTraces } = await listTraces({
            projectId,
            startTime: timeRange.startTime,
            endTime: timeRange.endTime,
            filter: `genkit/feature:${featureName}`,
            pageSize: 20,
          });
          return rawTraces.map(normalizeTraceForList);
        }
      ),
    [projectId, featureName, timeRange.preset]
  );

  const traces = tracesData || [];

  useInput((input, key) => {
    if (key.escape || (key.leftArrow && !key.shift)) {
      onNavigate({ type: 'overview' });
      return;
    }
    if (traces.length === 0) return;

    if (key.downArrow || input === 'j') {
      setSelectedIndex((i) => Math.min(i + 1, traces.length - 1));
    }
    if (key.upArrow || input === 'k') {
      setSelectedIndex((i) => Math.max(i - 1, 0));
    }
    if (key.return) {
      const trace = traces[selectedIndex];
      if (trace) onNavigate({ type: 'trace', traceId: trace.traceId, featureName });
    }
  });

  // Token bar chart
  const tokenBarData: Array<{ label: string; value: number; color: string }> = [];
  if (feature) {
    if (feature.inputTokens > 0) tokenBarData.push({ label: 'Input', value: feature.inputTokens, color: '#58a6ff' });
    if (feature.outputTokens > 0) tokenBarData.push({ label: 'Output', value: feature.outputTokens, color: '#d29922' });
    if (feature.thinkingTokens > 0) tokenBarData.push({ label: 'Thinking', value: feature.thinkingTokens, color: '#bc8cff' });
  }

  const failedCount = traces.filter((t) => t.rootSpan.status === 'error').length;

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box marginBottom={1}>
        <Text dimColor>← </Text>
        <Text bold color="cyan">{featureName}</Text>
      </Box>

      {/* Stats bar */}
      {feature && (
        <Box marginBottom={1} gap={2}>
          <Box>
            <Text dimColor>Total: </Text>
            <Text bold>{formatNumber(feature.totalRequests)}</Text>
          </Box>
          <Box>
            <Text dimColor>Success: </Text>
            <Text
              bold
              color={feature.successRate >= 0.95 ? 'green' : feature.successRate >= 0.5 ? 'yellow' : 'red'}
            >
              {formatPercent(feature.successRate)}
            </Text>
          </Box>
          <Box>
            <Text dimColor>Tokens: </Text>
            <Text color="blue">{formatNumber(feature.inputTokens)}</Text>
            <Text dimColor> in / </Text>
            <Text color="yellow">{formatNumber(feature.outputTokens)}</Text>
            <Text dimColor> out</Text>
          </Box>
          {feature.inputImages > 0 && (
            <Box>
              <Text dimColor>Images: </Text>
              <Text>{formatNumber(feature.inputImages)}</Text>
              <Text dimColor> in / </Text>
              <Text>{formatNumber(feature.outputImages)}</Text>
              <Text dimColor> out</Text>
            </Box>
          )}
        </Box>
      )}

      {/* Token usage chart */}
      {tokenBarData.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color="cyan">── Token Usage ──</Text>
          <BarChart data={tokenBarData} showValue="right" />
        </Box>
      )}

      {/* Traces list */}
      <Box flexDirection="column">
        <Box gap={1}>
          <Text bold color="cyan">── Traces ──</Text>
          {failedCount > 0 && (
            <Text color="red">⚠ {failedCount} failed</Text>
          )}
        </Box>

        {tracesLoading ? (
          <Box>
            <Text color="cyan"><Spinner type="dots" /></Text>
            <Text> Loading traces…</Text>
          </Box>
        ) : tracesError ? (
          <Text color="red">✗ {tracesError}</Text>
        ) : traces.length === 0 ? (
          <Text dimColor>No traces found for this feature in the selected time range.</Text>
        ) : (
          <>
            {/* Table header */}
            <Box>
              <Box width={6}><Text bold dimColor>Status</Text></Box>
              <Box width={20}><Text bold dimColor>Time</Text></Box>
              <Box width={10} justifyContent="flex-end"><Text bold dimColor>Duration</Text></Box>
              <Box width={30}><Text bold dimColor>  Model</Text></Box>
            </Box>
            <Text dimColor>{'─'.repeat(66)}</Text>

            {traces.map((trace, i) => (
              <TraceRow key={trace.traceId} trace={trace} selected={i === selectedIndex} />
            ))}
          </>
        )}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>
          [↑↓] Navigate  [Enter] View trace  [Esc/←] Back  [t] Time range  [q] Quit
        </Text>
      </Box>
    </Box>
  );
}

function TraceRow({ trace, selected }: { trace: TraceListItem; selected: boolean }) {
  const statusIcon = trace.rootSpan.status === 'success' ? '✓' : trace.rootSpan.status === 'error' ? '●' : '?';
  const statusColor = trace.rootSpan.status === 'success' ? 'green' : trace.rootSpan.status === 'error' ? 'red' : 'gray';
  const models = trace.models.map((m) => m.split('/').pop() || m).join(', ');

  return (
    <Box>
      <Box width={6}>
        <Text color={statusColor} bold={selected} inverse={selected}>
          {selected ? '▸' : ' '}{statusIcon}
        </Text>
      </Box>
      <Box width={20}>
        <Text color={selected ? 'cyan' : undefined}>{formatTime(trace.rootSpan.startTime)}</Text>
      </Box>
      <Box width={10} justifyContent="flex-end">
        <Text>{formatDuration(trace.rootSpan.durationMs)}</Text>
      </Box>
      <Box width={30}>
        <Text dimColor>  {truncate(models || '—', 28)}</Text>
      </Box>
    </Box>
  );
}
