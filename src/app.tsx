import React, { useState, useCallback } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import Spinner from 'ink-spinner';
import SelectInput from 'ink-select-input';
import { useAsync } from './hooks/use-async.js';
import { checkAuth } from './gcp/auth.js';
import { cache } from './gcp/cache.js';
import { ErrorDisplay } from './components/error-display.js';
import { OverviewScreen } from './screens/overview.js';
import { FeatureDetailScreen } from './screens/feature-detail.js';
import { TraceViewerScreen } from './screens/trace-viewer.js';
import {
  createTimeRange,
  type Screen,
  type TimeRange,
  type TimeRangePreset,
} from './types.js';

interface AppProps {
  projectId?: string;
  timeRangePreset?: TimeRangePreset;
}

const TIME_RANGE_OPTIONS: Array<{ label: string; value: TimeRangePreset }> = [
  { label: 'Last 1 hour', value: '1h' },
  { label: 'Last 6 hours', value: '6h' },
  { label: 'Last 24 hours', value: '24h' },
  { label: 'Last 7 days', value: '7d' },
  { label: 'Last 30 days', value: '30d' },
];

export function App({ projectId: initialProjectId, timeRangePreset = '24h' }: AppProps) {
  const { exit } = useApp();
  const [screen, setScreen] = useState<Screen>({ type: 'overview' });
  const [timeRange, setTimeRange] = useState<TimeRange>(createTimeRange(timeRangePreset));
  const [showTimeRangePicker, setShowTimeRangePicker] = useState(false);

  // Check auth and get project ID
  const { data: authStatus, loading: authLoading, error: authError } = useAsync(
    () => checkAuth(),
    []
  );

  const resolvedProjectId = initialProjectId || authStatus?.projectId;

  const handleNavigate = useCallback((newScreen: Screen) => {
    setScreen(newScreen);
  }, []);

  // Global key bindings
  useInput((input, key) => {
    // Quit
    if (input === 'q' && !showTimeRangePicker) {
      exit();
      return;
    }

    // Time range picker
    if (input === 't' && !showTimeRangePicker) {
      setShowTimeRangePicker(true);
      return;
    }
    if (key.escape && showTimeRangePicker) {
      setShowTimeRangePicker(false);
      return;
    }

    // Refresh
    if (input === 'r' && !showTimeRangePicker) {
      cache.clear();
      setTimeRange(createTimeRange(timeRange.preset));
    }
  });

  // Auth loading state
  if (authLoading) {
    return (
      <Box flexDirection="column" padding={1}>
        <Header timeRange={timeRange} projectId="…" />
        <Box>
          <Text color="cyan"><Spinner type="dots" /></Text>
          <Text> Authenticating with Google Cloud…</Text>
        </Box>
      </Box>
    );
  }

  // Auth error
  if (!authStatus?.authenticated || authError) {
    const errorMsg = authError || authStatus?.error || 'Not authenticated with Google Cloud';
    return (
      <Box flexDirection="column" padding={1}>
        <Header timeRange={timeRange} projectId="-" />
        <Box flexDirection="column" marginTop={1}>
          <ErrorDisplay error={errorMsg} context="authentication" showRetry={false} />
        </Box>
      </Box>
    );
  }

  if (!resolvedProjectId) {
    return (
      <Box flexDirection="column" padding={1}>
        <Header timeRange={timeRange} projectId="-" />
        <Box flexDirection="column" marginTop={1}>
          <Text color="red">✗ No GCP project found</Text>
          <Text />
          <Text>Specify a project with:</Text>
          <Text bold color="cyan">  genkit-gcp-goggles --project YOUR_PROJECT_ID</Text>
          <Text />
          <Text dimColor>Or set a default project:</Text>
          <Text dimColor>  gcloud config set project YOUR_PROJECT_ID</Text>
        </Box>
      </Box>
    );
  }

  // Time range picker overlay
  if (showTimeRangePicker) {
    return (
      <Box flexDirection="column" padding={1}>
        <Header timeRange={timeRange} projectId={resolvedProjectId} />
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="cyan">Select Time Range:</Text>
          <SelectInput
            items={TIME_RANGE_OPTIONS}
            initialIndex={TIME_RANGE_OPTIONS.findIndex((o) => o.value === timeRange.preset)}
            onSelect={(item) => {
              setTimeRange(createTimeRange(item.value as TimeRangePreset));
              cache.clear();
              setShowTimeRangePicker(false);
            }}
          />
          <Text dimColor>Press Esc to cancel</Text>
        </Box>
      </Box>
    );
  }

  // Main screen routing
  return (
    <Box flexDirection="column" padding={1} width="100%" height="100%">
      <Header timeRange={timeRange} projectId={resolvedProjectId} />
      <Text dimColor>{'━'.repeat(72)}</Text>
      <Box marginTop={1} flexGrow={1} flexDirection="column">
        {screen.type === 'overview' && (
          <OverviewScreen
            projectId={resolvedProjectId}
            timeRange={timeRange}
            onNavigate={handleNavigate}
          />
        )}
        {screen.type === 'feature' && (
          <FeatureDetailScreen
            projectId={resolvedProjectId}
            featureName={screen.featureName}
            timeRange={timeRange}
            onNavigate={handleNavigate}
          />
        )}
        {screen.type === 'trace' && (
          <TraceViewerScreen
            projectId={resolvedProjectId}
            traceId={screen.traceId}
            featureName={screen.featureName}
            onNavigate={handleNavigate}
          />
        )}
      </Box>
    </Box>
  );
}

function Header({ timeRange, projectId }: { timeRange: TimeRange; projectId: string }) {
  return (
    <Box>
      <Text bold color="cyan">🔍 Genkit GCP Goggles</Text>
      <Text>  </Text>
      <Text dimColor>project: </Text>
      <Text color="green">{projectId}</Text>
      <Text>  </Text>
      <Text dimColor>[</Text>
      <Text color="yellow">{timeRange.preset}</Text>
      <Text dimColor>]</Text>
    </Box>
  );
}
