import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { useAsync } from '../hooks/use-async.js';
import { getTrace, buildSpanTree, flattenSpanTree, type NormalizedSpan } from '../gcp/tracing.js';
import { fetchTraceLogEntries, type SpanIOFromLogs } from '../gcp/logging.js';
import { cache, CacheTTL } from '../gcp/cache.js';
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

  // Phase 1: Load trace spans only (fast — Cloud Trace API)
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

  // Phase 2: Load I/O from logs in background (lazy — Cloud Logging API)
  const { data: logIO, loading: logsLoading, error: logsError } = useAsync(
    () =>
      cache.getOrFetch(
        `trace-logs:${projectId}:${traceId}`,
        CacheTTL.TRACE_LOGS,
        () => fetchTraceLogEntries(projectId, traceId)
      ),
    [projectId, traceId]
  );

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

  useInput((input, key) => {
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
      setShowFullJson(false);
    }
    if (key.upArrow || input === 'k') {
      setSelectedIndex((i) => Math.max(i - 1, 0));
      setShowFullJson(false);
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

    // Toggle full JSON view
    if (input === 'i') {
      setShowFullJson((prev) => !prev);
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
      <Box flexDirection="column">
        <Text color="red">✗ Error loading trace:</Text>
        <Text color="red">{traceError}</Text>
        <Text dimColor>Press Esc to go back</Text>
      </Box>
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
              logsLoading={logsLoading}
              logsError={logsError || undefined}
              logIOSize={logIO?.size}
              showFullJson={showFullJson}
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
  logsLoading,
  logsError,
  logIOSize,
  showFullJson,
}: {
  span: NormalizedSpan;
  spanIO?: SpanIOFromLogs;
  logsLoading: boolean;
  logsError?: string;
  logIOSize?: number;
  showFullJson: boolean;
}) {
  const typeLabel = getSpanTypeLabel(span);
  const typeColor = getSpanTypeColor(typeLabel);
  const statusColor = span.status === 'success' ? 'green' : span.status === 'error' ? 'red' : 'gray';

  // Resolve input/output: prefer log-based I/O, fall back to trace labels.
  // While logs are loading, don't fall back to trace labels (which are usually
  // '<redacted>') — show a spinner instead and wait for log data.
  // If logs errored, fall back to trace labels immediately.
  const logsDone = !logsLoading || !!logsError;
  const rawInput = spanIO?.input || (logsDone ? span.input : '') || '';
  const rawOutput = spanIO?.output || (logsDone ? span.output : '') || '';

  // Try to pretty-print JSON
  const formatJson = (s: string): string => {
    if (!s || s === '<redacted>') return s || '—';
    try {
      return JSON.stringify(JSON.parse(s), null, 2);
    } catch {
      return s;
    }
  };

  const inputDisplay = rawInput && rawInput !== '<redacted>'
    ? (showFullJson ? formatJson(rawInput) : truncate(rawInput, 60))
    : (logsLoading ? null : (rawInput || '—'));
  const outputDisplay = rawOutput && rawOutput !== '<redacted>'
    ? (showFullJson ? formatJson(rawOutput) : truncate(rawOutput, 60))
    : (logsLoading ? null : (rawOutput || '—'));

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

      {/* Input */}
      <Box flexDirection="column" marginTop={1}>
        <Text bold dimColor>
          {typeLabel === 'flow' ? 'Flow input:' : 'Input:'}
        </Text>
        <Box borderStyle="single" borderColor="gray" paddingX={1}>
          {inputDisplay === null ? (
            <Box>
              <Text color="cyan"><Spinner type="dots" /></Text>
              <Text dimColor> Loading…</Text>
            </Box>
          ) : (
            <Text wrap="wrap">{inputDisplay}</Text>
          )}
        </Box>
      </Box>

      {/* Output */}
      <Box flexDirection="column" marginTop={1}>
        <Text bold dimColor>
          {typeLabel === 'flow' ? 'Flow output:' : 'Output:'}
        </Text>
        <Box borderStyle="single" borderColor="gray" paddingX={1}>
          {outputDisplay === null ? (
            <Box>
              <Text color="cyan"><Spinner type="dots" /></Text>
              <Text dimColor> Loading…</Text>
            </Box>
          ) : (
            <Text wrap="wrap" color={rawOutput === '<redacted>' ? 'yellow' : undefined}>
              {outputDisplay}
            </Text>
          )}
        </Box>
      </Box>

      {/* Span ID & debug info */}
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>ID: {span.spanId}</Text>
        {logsError && (
          <Text color="red">⚠ Logs error: {logsError}</Text>
        )}
        {!logsLoading && !logsError && logIOSize !== undefined && (
          <Text dimColor>Logs: {logIOSize} spans with I/O{spanIO ? ' (matched)' : ' (no match for this span)'}</Text>
        )}
      </Box>
    </Box>
  );
}
