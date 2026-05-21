import React, { useState, useMemo, useCallback } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import Spinner from 'ink-spinner';
import { useAsync } from '../hooks/use-async.js';
import { getTrace, buildSpanTree, flattenSpanTree, type NormalizedSpan } from '../gcp/tracing.js';
import { fetchTraceLogEntries, type SpanIOFromLogs } from '../gcp/logging.js';
import { cache, CacheTTL } from '../gcp/cache.js';
import { ErrorDisplay, InlineError } from '../components/error-display.js';
import { formatDuration, formatTime, truncate, type Screen } from '../types.js';

interface TraceViewerProps {
  projectId: string;
  traceId: string;
  featureName?: string;
  onNavigate: (screen: Screen) => void;
}

// Badge colors for span types (matching GCP Console)
const TYPE_COLORS: Record<string, string> = {
  flow: '#58a6ff',      // blue
  model: '#bc8cff',     // purple
  tool: '#3fb950',      // green
  step: '#79c0ff',      // light blue
  dotprompt: '#d29922', // yellow/amber
  util: '#8b949e',      // gray
  action: '#58a6ff',    // blue
  retrieve: '#f778ba',  // pink
  embed: '#f778ba',     // pink
};

function getSpanTypeLabel(span: NormalizedSpan): string {
  return span.subtype || span.type || 'unknown';
}

function getSpanTypeColor(label: string): string {
  const lower = label.toLowerCase();
  return TYPE_COLORS[lower] || '#8b949e';
}

export function TraceViewerScreen({ projectId, traceId, featureName, onNavigate }: TraceViewerProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showFullJson, setShowFullJson] = useState(false);
  const [scrollOffset, setScrollOffset] = useState(0);

  // Phase 1: Load trace spans only (fast, Cloud Trace API)
  const { data: traceData, loading: traceLoading, error: traceError } = useAsync(
    () =>
      cache.getOrFetch(
        `trace:${projectId}:${traceId}`,
        CacheTTL.TRACE_DETAIL,
        async () => {
          const rawTrace = await getTrace(projectId, traceId);
          const rootSpan = buildSpanTree(rawTrace.spans || []);
          const spans = rootSpan ? flattenSpanTree(rootSpan) : [];
          return { rootSpan, spans };
        }
      ),
    [projectId, traceId]
  );

  // Phase 2: Load I/O from logs ON-DEMAND only (user presses 'i')
  // This avoids 429 rate limiting from Cloud Logging API by not eagerly
  // fetching logs for every trace the user opens.
  const [logIO, setLogIO] = useState<Map<string, SpanIOFromLogs> | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState<string | null>(null);

  const loadLogs = useCallback(async () => {
    if (logsLoading) return; // already in progress
    setLogsLoading(true);
    setLogsError(null);
    try {
      const result = await cache.getOrFetch(
        `trace-logs:${projectId}:${traceId}`,
        CacheTTL.TRACE_LOGS,
        () => fetchTraceLogEntries(projectId, traceId)
      );
      setLogIO(result);
    } catch (err) {
      setLogsError(err instanceof Error ? err.message : String(err));
    } finally {
      setLogsLoading(false);
    }
  }, [projectId, traceId, logsLoading]);

  // Build visible span list (respecting collapsed state)
  const visibleSpans: Array<{ span: NormalizedSpan; depth: number }> = [];

  function collectVisible(span: NormalizedSpan, depth: number) {
    visibleSpans.push({ span, depth });
    const isCollapsed = expanded.has(span.spanId);
    if (!isCollapsed) {
      for (const child of span.children) {
        collectVisible(child, depth + 1);
      }
    }
  }

  if (traceData?.rootSpan) {
    collectVisible(traceData.rootSpan, 0);
  }

  const selectedSpan = visibleSpans[selectedIndex]?.span || null;

  // Look up I/O for the selected span from logs (or fall back to trace labels)
  const selectedSpanIO: SpanIOFromLogs | undefined = selectedSpan
    ? logIO?.get(selectedSpan.spanId)
    : undefined;

  // Build full I/O content lines for scrollable view
  const formatJson = (s: string): string => {
    if (!s || s === '<redacted>') return s || '-';
    try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; }
  };

  const logsDone = !logsLoading || !!logsError;
  const fullIOLines = useMemo(() => {
    if (!showFullJson || !selectedSpan) return [];
    const rawIn = selectedSpanIO?.input || (logsDone ? selectedSpan.input : '') || '';
    const rawOut = selectedSpanIO?.output || (logsDone ? selectedSpan.output : '') || '';
    const lines: string[] = [];
    lines.push(`── ${selectedSpan.name} ──`);
    lines.push('');
    lines.push('━━━ INPUT ━━━');
    lines.push(...(rawIn ? formatJson(rawIn) : '-').split('\n'));
    lines.push('');
    lines.push('━━━ OUTPUT ━━━');
    lines.push(...(rawOut ? formatJson(rawOut) : '-').split('\n'));
    return lines;
  }, [showFullJson, selectedSpan?.spanId, selectedSpanIO, logsDone]);

  const { stdout } = useStdout();
  const termRows = stdout.rows || 24;
  const viewportHeight = termRows - 4; // reserve header + footer

  useInput((input, key) => {
    // Full I/O scrollable view mode
    if (showFullJson) {
      if (input === 'i' || key.escape) {
        setShowFullJson(false);
        setScrollOffset(0);
        return;
      }
      const maxScroll = Math.max(0, fullIOLines.length - viewportHeight);
      if (key.downArrow || input === 'j') {
        setScrollOffset((o) => Math.min(o + 1, maxScroll));
      }
      if (key.upArrow || input === 'k') {
        setScrollOffset((o) => Math.max(o - 1, 0));
      }
      // Page down/up with space and shift
      if (input === ' ') {
        setScrollOffset((o) => Math.min(o + viewportHeight, maxScroll));
      }
      if (input === 'b') {
        setScrollOffset((o) => Math.max(o - viewportHeight, 0));
      }
      return;
    }

    if (key.escape || (key.leftArrow && !key.shift)) {
      if (featureName) {
        onNavigate({ type: 'feature', featureName });
      } else {
        onNavigate({ type: 'overview' });
      }
      return;
    }

    if (key.downArrow || input === 'j') {
      setSelectedIndex((i) => Math.min(i + 1, visibleSpans.length - 1));
    }
    if (key.upArrow || input === 'k') {
      setSelectedIndex((i) => Math.max(i - 1, 0));
    }

    // Toggle collapse/expand
    if (input === ' ' || key.rightArrow) {
      const span = visibleSpans[selectedIndex]?.span;
      if (span && span.children.length > 0) {
        setExpanded((prev) => {
          const next = new Set(prev);
          if (next.has(span.spanId)) {
            next.delete(span.spanId);
          } else {
            next.add(span.spanId);
          }
          return next;
        });
      }
    }

    // Toggle full JSON view, also triggers on-demand log loading
    if (input === 'i') {
      setShowFullJson(true);
      setScrollOffset(0);
      // Trigger log loading if not already loaded
      if (!logIO && !logsLoading) {
        loadLogs();
      }
    }
  });

  if (traceLoading) {
    return (
      <Box>
        <Text color="cyan"><Spinner type="dots" /></Text>
        <Text> Loading trace {traceId.slice(0, 16)}…</Text>
      </Box>
    );
  }

  if (traceError) {
    return (
      <ErrorDisplay error={traceError} context="trace" showRetry={true} showBack={true} />
    );
  }

  if (!traceData?.rootSpan) {
    return (
      <Box flexDirection="column">
        <Text color="yellow">No spans found for this trace.</Text>
        <Text dimColor>Press Esc to go back</Text>
      </Box>
    );
  }

  // Full-screen scrollable I/O view
  if (showFullJson && selectedSpan) {
    // Show loading state while logs are being fetched
    if (logsLoading && !logIO) {
      return (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text bold color="cyan">── Full I/O: </Text>
            <Text bold>{selectedSpan.name}</Text>
          </Box>
          <Box>
            <Text color="cyan"><Spinner type="dots" /></Text>
            <Text> Loading I/O from Cloud Logging…</Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>[i/Esc] Cancel</Text>
          </Box>
        </Box>
      );
    }

    // Show error if logs failed to load
    if (logsError && !logIO) {
      return (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text bold color="cyan">── Full I/O: </Text>
            <Text bold>{selectedSpan.name}</Text>
          </Box>
          <InlineError error={logsError} context="Cloud Logging" />
          <Box marginTop={1}>
            <Text dimColor>Showing trace label data (may be redacted)</Text>
          </Box>
          <Box flexDirection="column" marginTop={1}>
            {fullIOLines.map((line, i) => {
              const isHeader = line.startsWith('━━━');
              return (
                <Text key={i} wrap="truncate" color={isHeader ? 'cyan' : undefined} bold={isHeader}>
                  {line}
                </Text>
              );
            })}
          </Box>
          <Box marginTop={1}>
            <Text dimColor>[i/Esc] Back</Text>
          </Box>
        </Box>
      );
    }

    const visibleLines = fullIOLines.slice(scrollOffset, scrollOffset + viewportHeight);
    const maxScroll = Math.max(0, fullIOLines.length - viewportHeight);
    const scrollPct = maxScroll > 0 ? Math.round((scrollOffset / maxScroll) * 100) : 100;

    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text bold color="cyan">── Full I/O: </Text>
          <Text bold>{selectedSpan.name}</Text>
          <Text dimColor>  ({scrollPct}%)</Text>
        </Box>

        <Box flexDirection="column" height={viewportHeight}>
          {visibleLines.map((line, i) => {
            const isHeader = line.startsWith('━━━');
            return (
              <Text key={scrollOffset + i} wrap="truncate" color={isHeader ? 'cyan' : undefined} bold={isHeader}>
                {line}
              </Text>
            );
          })}
        </Box>

        <Box marginTop={1}>
          <Text dimColor>
            [↑↓/jk] Scroll  [Space] Page down  [b] Page up  [i/Esc] Back
          </Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box marginBottom={1}>
        <Text dimColor>← </Text>
        <Text bold color="cyan">Trace </Text>
        <Text dimColor>{traceId.slice(0, 24)}…</Text>
      </Box>

      <Box>
        {/* Span tree (left panel) */}
        <Box flexDirection="column" width="45%" marginRight={1}>
          <Text bold color="cyan">── Span Tree ──</Text>
          {visibleSpans.map(({ span, depth }, i) => (
            <SpanTreeNode
              key={span.spanId}
              span={span}
              depth={depth}
              selected={i === selectedIndex}
              hasChildren={span.children.length > 0}
              isCollapsed={expanded.has(span.spanId)}
            />
          ))}
        </Box>

        {/* Span detail (right panel) */}
        <Box flexDirection="column" width="55%">
          {selectedSpan && (
            <SpanDetailPanel
              span={selectedSpan}
              spanIO={selectedSpanIO}
              logsLoaded={logIO !== null}
              logsLoading={logsLoading}
              logsError={logsError || undefined}
              showFullJson={false}
            />
          )}
        </Box>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>
          [↑↓] Navigate  [Space/→] Toggle  [i] Full I/O  [Esc/←] Back  [q] Quit
        </Text>
      </Box>
    </Box>
  );
}

function SpanTreeNode({
  span,
  depth,
  selected,
  hasChildren,
  isCollapsed,
}: {
  span: NormalizedSpan;
  depth: number;
  selected: boolean;
  hasChildren: boolean;
  isCollapsed: boolean;
}) {
  const indent = '  '.repeat(depth);
  const statusIcon = span.status === 'success' ? '✓' : span.status === 'error' ? '✗' : '○';
  const statusColor = span.status === 'success' ? 'green' : span.status === 'error' ? 'red' : 'gray';
  const arrow = hasChildren ? (isCollapsed ? '▸' : '▾') : ' ';
  const name = span.name.split('/').pop() || span.name;
  const typeLabel = getSpanTypeLabel(span);
  const typeColor = getSpanTypeColor(typeLabel);

  // Calculate max name width based on depth
  const maxNameWidth = Math.max(8, 22 - depth * 2);

  return (
    <Box>
      <Text>{indent}</Text>
      <Text color={statusColor}>{statusIcon} </Text>
      <Text dimColor>{arrow} </Text>
      <Text
        color={selected ? 'cyan' : undefined}
        bold={selected}
        inverse={selected}
      >
        {truncate(name, maxNameWidth)}
      </Text>
      <Text dimColor> {formatDuration(span.durationMs)} </Text>
      <Text color={typeColor}>[{typeLabel}]</Text>
    </Box>
  );
}

function SpanDetailPanel({
  span,
  spanIO,
  logsLoaded,
  logsLoading,
  logsError,
  showFullJson,
}: {
  span: NormalizedSpan;
  spanIO?: SpanIOFromLogs;
  logsLoaded: boolean;
  logsLoading: boolean;
  logsError?: string;
  showFullJson: boolean;
}) {
  const typeLabel = getSpanTypeLabel(span);
  const typeColor = getSpanTypeColor(typeLabel);
  const statusColor = span.status === 'success' ? 'green' : span.status === 'error' ? 'red' : 'gray';

  // Resolve input/output: prefer log-based I/O, fall back to trace labels.
  const rawInput = spanIO?.input || span.input || '';
  const rawOutput = spanIO?.output || span.output || '';

  // Determine if we have real (non-redacted) data to show
  const inputIsReal = rawInput && rawInput !== '<redacted>';
  const outputIsReal = rawOutput && rawOutput !== '<redacted>';
  const hasRealData = inputIsReal || outputIsReal;

  // Only show I/O boxes if logs have been loaded OR trace labels have real data
  const showIO = logsLoaded || hasRealData;

  // Show truncated preview in compact mode
  const inputDisplay = inputIsReal ? truncate(rawInput, 200) : (rawInput || '-');
  const outputDisplay = outputIsReal ? truncate(rawOutput, 200) : (rawOutput || '-');

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">── Span Detail ──</Text>

      {/* Span header */}
      <Box>
        <Text bold>{span.name}</Text>
      </Box>

      {/* Badge row */}
      <Box gap={1} flexWrap="wrap">
        <Text color={statusColor} bold>
          {span.status === 'success' ? '✓ Successful' : span.status === 'error' ? '✗ Failed' : '○ Unknown'}
        </Text>
        <Text color={typeColor} bold>[{typeLabel}]</Text>
        <Text dimColor>⏱ {formatDuration(span.durationMs)}</Text>
        <Text dimColor>📅 {formatTime(span.startTime)}</Text>
      </Box>

      {span.modelName && (
        <Box>
          <Text dimColor>Model: </Text>
          <Text color="magenta">{span.modelName}</Text>
        </Box>
      )}

      {span.path && (
        <Box>
          <Text dimColor>Path: </Text>
          <Text>{span.path}</Text>
        </Box>
      )}

      {showIO ? (
        <>
          {/* Input */}
          <Box flexDirection="column" marginTop={1}>
            <Text bold dimColor>
              {typeLabel === 'flow' ? 'Flow input:' : 'Input:'}
            </Text>
            <Box borderStyle="single" borderColor="gray" paddingX={1}>
              <Text wrap="wrap">{inputDisplay}</Text>
            </Box>
          </Box>

          {/* Output */}
          <Box flexDirection="column" marginTop={1}>
            <Text bold dimColor>
              {typeLabel === 'flow' ? 'Flow output:' : 'Output:'}
            </Text>
            <Box borderStyle="single" borderColor="gray" paddingX={1}>
              <Text wrap="wrap">{outputDisplay}</Text>
            </Box>
          </Box>
        </>
      ) : (
        /* No I/O loaded yet, show clear CTA */
        <Box marginTop={1}>
          <Text color="cyan">📋 Press [i] to load full I/O from Cloud Logging</Text>
        </Box>
      )}

      {/* Span ID + loading/error status */}
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>ID: {span.spanId}</Text>
        {logsLoading && (
          <Box>
            <Text color="cyan"><Spinner type="dots" /></Text>
            <Text dimColor> Loading full I/O from logs…</Text>
          </Box>
        )}
        {logsError && (
          <InlineError error={logsError} context="logs" />
        )}
        {showIO && !logsLoaded && !logsLoading && (
          <Text dimColor>Press [i] for full I/O view</Text>
        )}
      </Box>
    </Box>
  );
}
