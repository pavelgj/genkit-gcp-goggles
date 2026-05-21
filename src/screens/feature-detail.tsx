import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { LineGraph } from '@pppp606/ink-chart';
import { useAsync } from '../hooks/use-async.js';
import { queryFeatureOverview, queryFeatureDetailTimeSeries } from '../gcp/monitoring.js';
import { listTraces, normalizeTraceForList, type TraceListItem } from '../gcp/tracing.js';
import { cache, CacheTTL } from '../gcp/cache.js';
import { ErrorDisplay } from '../components/error-display.js';
import {
  formatNumber,
  formatPercent,
  formatDuration,
  formatTime,
  truncate,
  type TimeRange,
  type Screen,
} from '../types.js';

interface FeatureDetailProps {
  projectId: string;
  featureName: string;
  timeRange: TimeRange;
  onNavigate: (screen: Screen) => void;
}

const PAGE_SIZE = 20;

export function FeatureDetailScreen({
  projectId,
  featureName,
  timeRange,
  onNavigate,
}: FeatureDetailProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [currentPage, setCurrentPage] = useState(0);
  const [pageTokens, setPageTokens] = useState<(string | undefined)[]>([undefined]);

  // Reset pagination when feature or time range changes
  useEffect(() => {
    setCurrentPage(0);
    setPageTokens([undefined]);
    setSelectedIndex(0);
  }, [featureName, timeRange.preset]);

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

  // Fetch time-series for charts
  const { data: timeSeries } = useAsync(
    () =>
      cache.getOrFetch(
        `feature-ts:${projectId}:${featureName}:${timeRange.preset}`,
        CacheTTL.METRICS,
        () =>
          queryFeatureDetailTimeSeries(
            projectId,
            featureName,
            timeRange.startTime,
            timeRange.endTime
          )
      ),
    [projectId, featureName, timeRange.preset]
  );

  // Fetch traces for this feature (paginated, ordered newest-first)
  const {
    data: tracesPage,
    loading: tracesLoading,
    error: tracesError,
  } = useAsync(
    () =>
      cache.getOrFetch(
        `traces:${projectId}:${featureName}:${timeRange.preset}:p${currentPage}:${pageTokens[currentPage] || ''}`,
        CacheTTL.TRACE_LIST,
        async () => {
          const { traces: rawTraces, nextPageToken } = await listTraces({
            projectId,
            startTime: timeRange.startTime,
            endTime: timeRange.endTime,
            filter: `genkit/feature:${featureName}`,
            pageSize: PAGE_SIZE,
            pageToken: pageTokens[currentPage],
            orderBy: 'start desc',
          });
          return {
            traces: rawTraces.map(normalizeTraceForList),
            nextPageToken,
          };
        }
      ),
    [projectId, featureName, timeRange.preset, currentPage]
  );

  // Store nextPageToken when new page data arrives
  useEffect(() => {
    if (tracesPage?.nextPageToken && !pageTokens[currentPage + 1]) {
      setPageTokens((prev) => {
        const next = [...prev];
        next[currentPage + 1] = tracesPage.nextPageToken;
        return next;
      });
    }
  }, [tracesPage, currentPage, pageTokens]);

  const traces = tracesPage?.traces || [];
  const hasNextPage = !!tracesPage?.nextPageToken;
  const hasPrevPage = currentPage > 0;

  useInput((input, key) => {
    if (key.escape || (key.leftArrow && !key.shift)) {
      onNavigate({ type: 'overview' });
      return;
    }

    // Pagination
    if (input === 'n' && hasNextPage && !tracesLoading) {
      setCurrentPage((p) => p + 1);
      setSelectedIndex(0);
      return;
    }
    if (input === 'p' && hasPrevPage && !tracesLoading) {
      setCurrentPage((p) => p - 1);
      setSelectedIndex(0);
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

  const failedCount = traces.filter((t) => t.rootSpan.status === 'error').length;

  // Extract chart values
  const reqValues = timeSeries?.requests.map((p) => p.value) || [];
  const successValues = timeSeries?.successRate.map((p) => p.value) || [];
  const latP95Values = timeSeries?.latencyP95.map((p) => p.value) || [];
  const latP50Values = timeSeries?.latencyP50.map((p) => p.value) || [];
  const inTokValues = timeSeries?.inputTokens.map((p) => p.value) || [];
  const outTokValues = timeSeries?.outputTokens.map((p) => p.value) || [];
  const hasCharts =
    reqValues.length > 1 || successValues.length > 1 || inTokValues.length > 1;

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box marginBottom={1}>
        <Text dimColor>← </Text>
        <Text bold color="cyan">
          {featureName}
        </Text>
      </Box>

      {/* Stability metrics bar */}
      {feature && (
        <Box marginBottom={1} gap={2} flexWrap="wrap">
          <Box>
            <Text dimColor>Total requests </Text>
            <Text bold>{formatNumber(feature.totalRequests)}</Text>
          </Box>
          <Box>
            <Text dimColor>Success rate </Text>
            <Text
              bold
              color={
                feature.successRate >= 0.95
                  ? 'green'
                  : feature.successRate >= 0.5
                    ? 'yellow'
                    : 'red'
              }
            >
              {formatPercent(feature.successRate)}
            </Text>
          </Box>
          <Box>
            <Text dimColor>Latency (p95) </Text>
            <Text bold>
              {feature.latencyP95Ms != null ? formatDuration(feature.latencyP95Ms) : '—'}
            </Text>
          </Box>
          <Box>
            <Text dimColor>Tokens </Text>
            <Text color="blue">{formatNumber(feature.inputTokens)}</Text>
            <Text dimColor> / </Text>
            <Text color="yellow">{formatNumber(feature.outputTokens)}</Text>
            <Text dimColor> / </Text>
            <Text color="magenta">{formatNumber(feature.thinkingTokens)}</Text>
          </Box>
          {(feature.inputImages > 0 || feature.outputImages > 0) && (
            <Box>
              <Text dimColor>Images </Text>
              <Text>{formatNumber(feature.inputImages)}</Text>
              <Text dimColor> / </Text>
              <Text>{formatNumber(feature.outputImages)}</Text>
            </Box>
          )}
        </Box>
      )}

      {/* Time-series charts (2x2 grid) */}
      {hasCharts && (
        <Box flexDirection="column" marginBottom={1}>
          {/* Row 1: Requests + Tokens */}
          <Box marginBottom={1}>
            <Box flexDirection="column" marginRight={2} width="50%">
              <Text bold color="cyan">
                Requests
              </Text>
              {reqValues.length > 1 ? (
                <LineGraph
                  data={[{ values: reqValues, color: '#58a6ff' }]}
                  height={4}
                  width={32}
                  showYAxis={true}
                />
              ) : (
                <Text dimColor>No data</Text>
              )}
            </Box>
            <Box flexDirection="column" width="50%">
              <Text bold color="cyan">
                Tokens
              </Text>
              {inTokValues.length > 1 || outTokValues.length > 1 ? (
                <LineGraph
                  data={[
                    ...(inTokValues.length > 1
                      ? [{ values: inTokValues, color: '#58a6ff' }]
                      : []),
                    ...(outTokValues.length > 1
                      ? [{ values: outTokValues, color: '#d29922' }]
                      : []),
                  ]}
                  height={4}
                  width={32}
                  showYAxis={true}
                />
              ) : (
                <Text dimColor>No data</Text>
              )}
              {(inTokValues.length > 1 || outTokValues.length > 1) && (
                <Box gap={2}>
                  <Text color="#58a6ff" dimColor>
                    ● Input
                  </Text>
                  <Text color="#d29922" dimColor>
                    ● Output
                  </Text>
                </Box>
              )}
            </Box>
          </Box>

          {/* Row 2: Success Rate + Latency */}
          <Box>
            <Box flexDirection="column" marginRight={2} width="50%">
              <Text bold color="cyan">
                Success rate
              </Text>
              {successValues.length > 1 ? (
                <LineGraph
                  data={[{ values: successValues, color: '#3fb950' }]}
                  height={4}
                  width={32}
                  showYAxis={true}
                  yDomain={[0, 100] as [number, number]}
                />
              ) : (
                <Text dimColor>No data</Text>
              )}
            </Box>
            <Box flexDirection="column" width="50%">
              <Text bold color="cyan">
                Latency
              </Text>
              {latP95Values.length > 1 ? (
                <LineGraph
                  data={[
                    { values: latP95Values, color: '#58a6ff' },
                    ...(latP50Values.length > 1
                      ? [{ values: latP50Values, color: '#d29922' }]
                      : []),
                  ]}
                  height={4}
                  width={32}
                  showYAxis={true}
                />
              ) : (
                <Text dimColor>No data</Text>
              )}
              {latP95Values.length > 1 && (
                <Box gap={2}>
                  <Text color="#58a6ff" dimColor>
                    ● p95
                  </Text>
                  {latP50Values.length > 1 && (
                    <Text color="#d29922" dimColor>
                      ● p50
                    </Text>
                  )}
                </Box>
              )}
            </Box>
          </Box>
        </Box>
      )}

      {/* Traces list */}
      <Box flexDirection="column">
        <Box gap={1}>
          <Text bold color="cyan">
            ── Traces ──
          </Text>
          {failedCount > 0 && <Text color="red">⚠ {failedCount} failed</Text>}
          <Text dimColor>
            Page {currentPage + 1}
            {hasNextPage ? '' : ' (last)'}
          </Text>
        </Box>

        {tracesLoading ? (
          <Box>
            <Text color="cyan">
              <Spinner type="dots" />
            </Text>
            <Text> Loading traces…</Text>
          </Box>
        ) : tracesError ? (
          <ErrorDisplay error={tracesError} context="traces" showRetry={true} showBack={true} />
        ) : traces.length === 0 ? (
          <Text dimColor>No traces found for this feature in the selected time range.</Text>
        ) : (
          <>
            {/* Table header */}
            <Box>
              <Box width={4}>
                <Text bold dimColor>
                  St
                </Text>
              </Box>
              <Box width={20}>
                <Text bold dimColor>
                  Time
                </Text>
              </Box>
              <Box width={10} justifyContent="flex-end">
                <Text bold dimColor>
                  Duration
                </Text>
              </Box>
              <Box width={6} justifyContent="flex-end">
                <Text bold dimColor>
                  Spans
                </Text>
              </Box>
              <Box width={30}>
                <Text bold dimColor>
                  {'  '}Model
                </Text>
              </Box>
            </Box>
            <Text dimColor>{'─'.repeat(70)}</Text>

            {traces.map((trace, i) => (
              <TraceRow key={trace.traceId} trace={trace} selected={i === selectedIndex} />
            ))}
          </>
        )}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>
          [↑↓] Navigate [Enter] View trace
          {hasNextPage ? ' [n] Next page' : ''}
          {hasPrevPage ? ' [p] Prev page' : ''}
          {' '}[Esc/←] Back [q] Quit
        </Text>
      </Box>
    </Box>
  );
}

function TraceRow({ trace, selected }: { trace: TraceListItem; selected: boolean }) {
  const statusIcon =
    trace.rootSpan.status === 'success'
      ? '✓'
      : trace.rootSpan.status === 'error'
        ? '✗'
        : '?';
  const statusColor =
    trace.rootSpan.status === 'success'
      ? 'green'
      : trace.rootSpan.status === 'error'
        ? 'red'
        : 'gray';
  const models = trace.models
    .map((m) => m.split('/').pop() || m)
    .join(', ');

  return (
    <Box>
      <Box width={4}>
        <Text color={statusColor} bold={selected} inverse={selected}>
          {selected ? '▸' : ' '}
          {statusIcon}
        </Text>
      </Box>
      <Box width={20}>
        <Text color={selected ? 'cyan' : undefined}>{formatTime(trace.rootSpan.startTime)}</Text>
      </Box>
      <Box width={10} justifyContent="flex-end">
        <Text>{formatDuration(trace.rootSpan.durationMs)}</Text>
      </Box>
      <Box width={6} justifyContent="flex-end">
        <Text dimColor>{trace.spanCount}</Text>
      </Box>
      <Box width={30}>
        <Text dimColor>{'  '}{truncate(models || '—', 28)}</Text>
      </Box>
    </Box>
  );
}
