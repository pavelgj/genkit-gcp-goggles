import { getAccessToken } from './auth.js';

const MONITORING_BASE = 'https://monitoring.googleapis.com/v3';
const METRIC_PREFIX = 'workload.googleapis.com/genkit';

/**
 * Catch handler for non-critical metric queries.
 * Re-throws auth/permission errors so they bubble up to the UI.
 * Swallows other errors (e.g., metric type not found) and returns empty array.
 */
function catchNonCritical(err: unknown): never | [] {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  // Re-throw auth and permission errors — these need user action
  if (
    lower.includes('401') ||
    lower.includes('403') ||
    lower.includes('unauthenticated') ||
    lower.includes('permission') ||
    lower.includes('forbidden') ||
    lower.includes('access denied') ||
    lower.includes('failed to get access token') ||
    lower.includes('default credentials') ||
    lower.includes('invalid_grant') ||
    lower.includes('token has been expired')
  ) {
    throw err;
  }
  // Non-critical: metric not found, empty series, etc.
  return [];
}

export const GenkitMetrics = {
  FEATURE_REQUESTS: `${METRIC_PREFIX}/feature/requests`,
  FEATURE_LATENCY: `${METRIC_PREFIX}/feature/latency`,
  FEATURE_PATH_REQUESTS: `${METRIC_PREFIX}/feature/path/requests`,
  FEATURE_PATH_LATENCY: `${METRIC_PREFIX}/feature/path/latency`,
  GENERATE_REQUESTS: `${METRIC_PREFIX}/ai/generate/requests`,
  GENERATE_LATENCY: `${METRIC_PREFIX}/ai/generate/latency`,
  GENERATE_INPUT_TOKENS: `${METRIC_PREFIX}/ai/generate/input/tokens`,
  GENERATE_OUTPUT_TOKENS: `${METRIC_PREFIX}/ai/generate/output/tokens`,
  GENERATE_INPUT_CHARS: `${METRIC_PREFIX}/ai/generate/input/characters`,
  GENERATE_OUTPUT_CHARS: `${METRIC_PREFIX}/ai/generate/output/characters`,
  GENERATE_INPUT_IMAGES: `${METRIC_PREFIX}/ai/generate/input/images`,
  GENERATE_OUTPUT_IMAGES: `${METRIC_PREFIX}/ai/generate/output/images`,
  ACTION_REQUESTS: `${METRIC_PREFIX}/action/requests`,
  ACTION_LATENCY: `${METRIC_PREFIX}/action/latency`,
} as const;

interface MonitoringQueryParams {
  projectId: string;
  metricType: string;
  startTime: string;
  endTime: string;
  alignmentPeriod?: string;
  perSeriesAligner?: string;
  crossSeriesReducer?: string;
  groupByFields?: string[];
  filter?: string;
}

interface GcpTimeSeries {
  metric: {
    labels: Record<string, string>;
    type: string;
  };
  resource: {
    type: string;
    labels: Record<string, string>;
  };
  points: Array<{
    interval: { startTime: string; endTime: string };
    value: {
      int64Value?: string;
      doubleValue?: number;
      distributionValue?: {
        count: string;
        mean: number;
        bucketCounts: string[];
        bucketOptions: unknown;
      };
    };
  }>;
}

interface GcpTimeSeriesResponse {
  timeSeries?: GcpTimeSeries[];
  nextPageToken?: string;
}

export function computeAlignmentPeriod(startTime: string, endTime: string): string {
  const durationMs = new Date(endTime).getTime() - new Date(startTime).getTime();
  const hours = durationMs / (1000 * 60 * 60);
  if (hours <= 1) return '60s';
  if (hours <= 6) return '120s';
  if (hours <= 24) return '600s';
  if (hours <= 168) return '3600s';
  return '14400s';
}

export async function queryTimeSeries(params: MonitoringQueryParams): Promise<GcpTimeSeries[]> {
  const token = await getAccessToken();
  const {
    projectId, metricType, startTime, endTime,
    alignmentPeriod, perSeriesAligner, crossSeriesReducer,
    groupByFields, filter: additionalFilter,
  } = params;

  const period = alignmentPeriod || computeAlignmentPeriod(startTime, endTime);
  const aligner = perSeriesAligner || 'ALIGN_DELTA';

  let filterStr = `metric.type="${metricType}"`;
  if (additionalFilter) filterStr += ` AND ${additionalFilter}`;

  const queryParams = new URLSearchParams({
    filter: filterStr,
    'interval.startTime': startTime,
    'interval.endTime': endTime,
    'aggregation.alignmentPeriod': period,
    'aggregation.perSeriesAligner': aligner,
  });

  if (crossSeriesReducer) {
    queryParams.set('aggregation.crossSeriesReducer', crossSeriesReducer);
  }
  if (groupByFields) {
    for (const field of groupByFields) {
      queryParams.append('aggregation.groupByFields', field);
    }
  }

  const allTimeSeries: GcpTimeSeries[] = [];
  let pageToken: string | undefined;

  do {
    if (pageToken) queryParams.set('pageToken', pageToken);
    const url = `${MONITORING_BASE}/projects/${projectId}/timeSeries?${queryParams.toString()}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Cloud Monitoring API error (${response.status}): ${error}`);
    }

    const data = (await response.json()) as GcpTimeSeriesResponse;
    if (data.timeSeries) allTimeSeries.push(...data.timeSeries);
    pageToken = data.nextPageToken;
  } while (pageToken);

  return allTimeSeries;
}

function extractPointValue(point: GcpTimeSeries['points'][0]): number {
  if (point.value.int64Value !== undefined) return parseInt(point.value.int64Value, 10);
  if (point.value.doubleValue !== undefined) return point.value.doubleValue;
  if (point.value.distributionValue) return point.value.distributionValue.mean;
  return 0;
}

export function normalizeTimeSeries(
  gcpSeries: GcpTimeSeries[]
): Array<{ labels: Record<string, string>; points: Array<{ time: string; value: number }> }> {
  return gcpSeries.map((series) => ({
    labels: series.metric.labels || {},
    points: (series.points || [])
      .map((p) => ({ time: p.interval.endTime, value: extractPointValue(p) }))
      .reverse(),
  }));
}

// ── Feature Overview (table data) ──────────────────────────────────────────────

export interface FeatureOverview {
  name: string;
  totalRequests: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  inputImages: number;
  outputImages: number;
  requestSeries: number[]; // for sparkline
}

export async function queryFeatureOverview(
  projectId: string,
  startTime: string,
  endTime: string
): Promise<FeatureOverview[]> {
  const requestsData = await queryTimeSeries({
    projectId,
    metricType: GenkitMetrics.FEATURE_REQUESTS,
    startTime,
    endTime,
    perSeriesAligner: 'ALIGN_DELTA',
    crossSeriesReducer: 'REDUCE_SUM',
    groupByFields: ['metric.label.name', 'metric.label.status'],
  });

  // Also fetch per-feature request time-series (for sparklines)
  const perFeatureRequestsData = await queryTimeSeries({
    projectId,
    metricType: GenkitMetrics.FEATURE_REQUESTS,
    startTime,
    endTime,
    perSeriesAligner: 'ALIGN_DELTA',
    crossSeriesReducer: 'REDUCE_SUM',
    groupByFields: ['metric.label.name'],
  }).catch(catchNonCritical);

  const [inputTokensData, outputTokensData, inputImagesData, outputImagesData, latencyP95Data] =
    await Promise.all([
      queryTimeSeries({
        projectId,
        metricType: GenkitMetrics.GENERATE_INPUT_TOKENS,
        startTime, endTime,
        perSeriesAligner: 'ALIGN_DELTA',
        crossSeriesReducer: 'REDUCE_SUM',
        groupByFields: ['metric.label.featureName'],
      }).catch(catchNonCritical),
      queryTimeSeries({
        projectId,
        metricType: GenkitMetrics.GENERATE_OUTPUT_TOKENS,
        startTime, endTime,
        perSeriesAligner: 'ALIGN_DELTA',
        crossSeriesReducer: 'REDUCE_SUM',
        groupByFields: ['metric.label.featureName'],
      }).catch(catchNonCritical),
      queryTimeSeries({
        projectId,
        metricType: GenkitMetrics.GENERATE_INPUT_IMAGES,
        startTime, endTime,
        perSeriesAligner: 'ALIGN_DELTA',
        crossSeriesReducer: 'REDUCE_SUM',
        groupByFields: ['metric.label.featureName'],
      }).catch(catchNonCritical),
      queryTimeSeries({
        projectId,
        metricType: GenkitMetrics.GENERATE_OUTPUT_IMAGES,
        startTime, endTime,
        perSeriesAligner: 'ALIGN_DELTA',
        crossSeriesReducer: 'REDUCE_SUM',
        groupByFields: ['metric.label.featureName'],
      }).catch(catchNonCritical),
      queryTimeSeries({
        projectId,
        metricType: GenkitMetrics.FEATURE_LATENCY,
        startTime, endTime,
        perSeriesAligner: 'ALIGN_DELTA',
        crossSeriesReducer: 'REDUCE_PERCENTILE_95',
        groupByFields: ['metric.label.name'],
      }).catch(catchNonCritical),
    ]);

  const featureMap = new Map<string, {
    successCount: number; failureCount: number;
    inputTokens: number; outputTokens: number; thinkingTokens: number;
    inputImages: number; outputImages: number;
    latencyP95Ms: number | null;
    requestSeries: number[];
  }>();

  const getOrCreate = (name: string) => {
    if (!featureMap.has(name)) {
      featureMap.set(name, {
        successCount: 0, failureCount: 0,
        inputTokens: 0, outputTokens: 0, thinkingTokens: 0,
        inputImages: 0, outputImages: 0,
        latencyP95Ms: null,
        requestSeries: [],
      });
    }
    return featureMap.get(name)!;
  };

  for (const series of requestsData) {
    const name = series.metric.labels?.name || '<unknown>';
    const status = series.metric.labels?.status;
    const total = (series.points || []).reduce((sum, p) => sum + extractPointValue(p), 0);
    const feature = getOrCreate(name);
    if (status === 'success') feature.successCount += total;
    else feature.failureCount += total;
  }

  const sumPoints = (series: GcpTimeSeries) =>
    (series.points || []).reduce((sum, p) => sum + extractPointValue(p), 0);

  for (const s of inputTokensData) {
    getOrCreate(s.metric.labels?.featureName || '<unknown>').inputTokens += sumPoints(s);
  }
  for (const s of outputTokensData) {
    getOrCreate(s.metric.labels?.featureName || '<unknown>').outputTokens += sumPoints(s);
  }
  for (const s of inputImagesData) {
    getOrCreate(s.metric.labels?.featureName || '<unknown>').inputImages += sumPoints(s);
  }
  for (const s of outputImagesData) {
    getOrCreate(s.metric.labels?.featureName || '<unknown>').outputImages += sumPoints(s);
  }

  // Process latency p95 per feature
  for (const s of latencyP95Data) {
    const name = s.metric.labels?.name || '<unknown>';
    const feature = getOrCreate(name);
    const values = (s.points || []).map((p) => extractPointValue(p)).filter((v) => v > 0);
    if (values.length > 0) {
      // Take the max p95 across all time buckets as the aggregate p95
      feature.latencyP95Ms = Math.max(...values);
    }
  }

  // Process per-feature request sparklines
  for (const s of perFeatureRequestsData) {
    const name = s.metric.labels?.name || '<unknown>';
    const feature = getOrCreate(name);
    feature.requestSeries = (s.points || [])
      .map((p) => extractPointValue(p))
      .reverse(); // chronological order
  }

  return Array.from(featureMap.entries())
    .map(([name, data]) => {
      const total = data.successCount + data.failureCount;
      return {
        name,
        totalRequests: total,
        successCount: data.successCount,
        failureCount: data.failureCount,
        successRate: total > 0 ? data.successCount / total : 0,
        latencyP50Ms: null,
        latencyP95Ms: data.latencyP95Ms,
        inputTokens: data.inputTokens,
        outputTokens: data.outputTokens,
        thinkingTokens: data.thinkingTokens,
        inputImages: data.inputImages,
        outputImages: data.outputImages,
        requestSeries: data.requestSeries,
      };
    })
    .sort((a, b) => b.totalRequests - a.totalRequests);
}

// ── Time-Series data for charts ────────────────────────────────────────────────

export interface TimeSeriesPoint {
  time: string;
  value: number;
}

export interface OverviewTimeSeries {
  requests: TimeSeriesPoint[];
  successRequests: TimeSeriesPoint[];
  failureRequests: TimeSeriesPoint[];
  successRate: TimeSeriesPoint[];
  latencyP95: TimeSeriesPoint[];
  // Aggregate stats for chart headers
  totalRequestCount: number;
  overallSuccessRate: number;
  latencyP95Value: number | null;
}

/** Merge success/failure request series into total, success, failure, and success rate */
function mergeRequestSeries(
  normalized: Array<{ labels: Record<string, string>; points: TimeSeriesPoint[] }>
): {
  requests: TimeSeriesPoint[];
  successRequests: TimeSeriesPoint[];
  failureRequests: TimeSeriesPoint[];
  successRate: TimeSeriesPoint[];
} {
  const timeMap = new Map<string, { success: number; failure: number }>();

  for (const series of normalized) {
    const isSuccess = series.labels.status === 'success';
    for (const p of series.points) {
      const entry = timeMap.get(p.time) || { success: 0, failure: 0 };
      if (isSuccess) entry.success += p.value;
      else entry.failure += p.value;
      timeMap.set(p.time, entry);
    }
  }

  const sorted = Array.from(timeMap.entries()).sort(([a], [b]) => a.localeCompare(b));

  return {
    requests: sorted.map(([time, { success, failure }]) => ({ time, value: success + failure })),
    successRequests: sorted.map(([time, { success }]) => ({ time, value: success })),
    failureRequests: sorted.map(([time, { failure }]) => ({ time, value: failure })),
    successRate: sorted.map(([time, { success, failure }]) => {
      const total = success + failure;
      return { time, value: total > 0 ? (success / total) * 100 : 100 };
    }),
  };
}

/** Fetch time-series for overview page charts */
export async function queryOverviewTimeSeries(
  projectId: string,
  startTime: string,
  endTime: string
): Promise<OverviewTimeSeries> {
  const [requestsRaw, featureLatencyRaw] = await Promise.all([
    queryTimeSeries({
      projectId,
      metricType: GenkitMetrics.FEATURE_REQUESTS,
      startTime,
      endTime,
      perSeriesAligner: 'ALIGN_DELTA',
      crossSeriesReducer: 'REDUCE_SUM',
      groupByFields: ['metric.label.status'],
    }),
    queryTimeSeries({
      projectId,
      metricType: GenkitMetrics.FEATURE_LATENCY,
      startTime,
      endTime,
      perSeriesAligner: 'ALIGN_DELTA',
      crossSeriesReducer: 'REDUCE_PERCENTILE_99',
    }).catch(catchNonCritical),
  ]);

  // If FEATURE_LATENCY returned nothing, try ACTION_LATENCY as fallback
  let latencyRaw = featureLatencyRaw;
  if (latencyRaw.length === 0) {
    latencyRaw = await queryTimeSeries({
      projectId,
      metricType: GenkitMetrics.ACTION_LATENCY,
      startTime,
      endTime,
      perSeriesAligner: 'ALIGN_DELTA',
      crossSeriesReducer: 'REDUCE_PERCENTILE_99',
    }).catch(catchNonCritical);
  }

  const requestsNorm = normalizeTimeSeries(requestsRaw);
  const { requests, successRequests, failureRequests, successRate } =
    mergeRequestSeries(requestsNorm);

  const latencyNorm = normalizeTimeSeries(latencyRaw);
  const latencyP95 = latencyNorm.length > 0 ? latencyNorm[0].points : [];

  // Compute aggregate stats
  const totalRequestCount = requests.reduce((sum, p) => sum + p.value, 0);
  const totalSuccess = successRequests.reduce((sum, p) => sum + p.value, 0);
  const overallSuccessRate =
    totalRequestCount > 0 ? (totalSuccess / totalRequestCount) * 100 : 100;
  const latencyP95Value =
    latencyP95.length > 0
      ? Math.max(...latencyP95.map((p) => p.value))
      : null;

  return {
    requests,
    successRequests,
    failureRequests,
    successRate,
    latencyP95,
    totalRequestCount,
    overallSuccessRate,
    latencyP95Value,
  };
}

// ── Feature Detail Time-Series ─────────────────────────────────────────────────

export interface FeatureDetailTimeSeries {
  requests: TimeSeriesPoint[];
  successRate: TimeSeriesPoint[];
  latencyP95: TimeSeriesPoint[];
  latencyP50: TimeSeriesPoint[];
  inputTokens: TimeSeriesPoint[];
  outputTokens: TimeSeriesPoint[];
}

/** Fetch time-series for feature detail page charts */
export async function queryFeatureDetailTimeSeries(
  projectId: string,
  featureName: string,
  startTime: string,
  endTime: string
): Promise<FeatureDetailTimeSeries> {
  const nameFilter = `metric.label.name="${featureName}"`;
  const featureNameFilter = `metric.label.featureName="${featureName}"`;

  const [requestsRaw, latencyP95Raw, latencyP50Raw, inputTokensRaw, outputTokensRaw] =
    await Promise.all([
      queryTimeSeries({
        projectId,
        metricType: GenkitMetrics.FEATURE_REQUESTS,
        startTime,
        endTime,
        perSeriesAligner: 'ALIGN_DELTA',
        crossSeriesReducer: 'REDUCE_SUM',
        groupByFields: ['metric.label.status'],
        filter: nameFilter,
      }),
      queryTimeSeries({
        projectId,
        metricType: GenkitMetrics.FEATURE_LATENCY,
        startTime,
        endTime,
        perSeriesAligner: 'ALIGN_DELTA',
        crossSeriesReducer: 'REDUCE_PERCENTILE_95',
        filter: nameFilter,
      }).catch(catchNonCritical),
      queryTimeSeries({
        projectId,
        metricType: GenkitMetrics.FEATURE_LATENCY,
        startTime,
        endTime,
        perSeriesAligner: 'ALIGN_DELTA',
        crossSeriesReducer: 'REDUCE_PERCENTILE_50',
        filter: nameFilter,
      }).catch(catchNonCritical),
      queryTimeSeries({
        projectId,
        metricType: GenkitMetrics.GENERATE_INPUT_TOKENS,
        startTime,
        endTime,
        perSeriesAligner: 'ALIGN_DELTA',
        crossSeriesReducer: 'REDUCE_SUM',
        filter: featureNameFilter,
      }).catch(catchNonCritical),
      queryTimeSeries({
        projectId,
        metricType: GenkitMetrics.GENERATE_OUTPUT_TOKENS,
        startTime,
        endTime,
        perSeriesAligner: 'ALIGN_DELTA',
        crossSeriesReducer: 'REDUCE_SUM',
        filter: featureNameFilter,
      }).catch(catchNonCritical),
    ]);

  const requestsNorm = normalizeTimeSeries(requestsRaw);
  const { requests, successRate } = mergeRequestSeries(requestsNorm);

  const p95Norm = normalizeTimeSeries(latencyP95Raw);
  const p50Norm = normalizeTimeSeries(latencyP50Raw);
  const inNorm = normalizeTimeSeries(inputTokensRaw);
  const outNorm = normalizeTimeSeries(outputTokensRaw);

  return {
    requests,
    successRate,
    latencyP95: p95Norm[0]?.points || [],
    latencyP50: p50Norm[0]?.points || [],
    inputTokens: inNorm[0]?.points || [],
    outputTokens: outNorm[0]?.points || [],
  };
}

export async function queryFeatureTimeSeries(
  projectId: string,
  metricType: string,
  startTime: string,
  endTime: string,
  featureName?: string,
): Promise<Array<{ labels: Record<string, string>; points: Array<{ time: string; value: number }> }>> {
  const filter = featureName ? `metric.label.name="${featureName}"` : undefined;
  const raw = await queryTimeSeries({
    projectId,
    metricType,
    startTime,
    endTime,
    perSeriesAligner: 'ALIGN_DELTA',
    crossSeriesReducer: 'REDUCE_SUM',
    groupByFields: ['metric.label.name', 'metric.label.status'],
    filter,
  });
  return normalizeTimeSeries(raw);
}
