import { getAccessToken } from './auth.js';

const MONITORING_BASE = 'https://monitoring.googleapis.com/v3';
const METRIC_PREFIX = 'workload.googleapis.com/genkit';

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

  const [inputTokensData, outputTokensData, inputImagesData, outputImagesData] =
    await Promise.all([
      queryTimeSeries({
        projectId,
        metricType: GenkitMetrics.GENERATE_INPUT_TOKENS,
        startTime, endTime,
        perSeriesAligner: 'ALIGN_DELTA',
        crossSeriesReducer: 'REDUCE_SUM',
        groupByFields: ['metric.label.featureName'],
      }).catch(() => []),
      queryTimeSeries({
        projectId,
        metricType: GenkitMetrics.GENERATE_OUTPUT_TOKENS,
        startTime, endTime,
        perSeriesAligner: 'ALIGN_DELTA',
        crossSeriesReducer: 'REDUCE_SUM',
        groupByFields: ['metric.label.featureName'],
      }).catch(() => []),
      queryTimeSeries({
        projectId,
        metricType: GenkitMetrics.GENERATE_INPUT_IMAGES,
        startTime, endTime,
        perSeriesAligner: 'ALIGN_DELTA',
        crossSeriesReducer: 'REDUCE_SUM',
        groupByFields: ['metric.label.featureName'],
      }).catch(() => []),
      queryTimeSeries({
        projectId,
        metricType: GenkitMetrics.GENERATE_OUTPUT_IMAGES,
        startTime, endTime,
        perSeriesAligner: 'ALIGN_DELTA',
        crossSeriesReducer: 'REDUCE_SUM',
        groupByFields: ['metric.label.featureName'],
      }).catch(() => []),
    ]);

  const featureMap = new Map<string, {
    successCount: number; failureCount: number;
    inputTokens: number; outputTokens: number; thinkingTokens: number;
    inputImages: number; outputImages: number;
  }>();

  const getOrCreate = (name: string) => {
    if (!featureMap.has(name)) {
      featureMap.set(name, {
        successCount: 0, failureCount: 0,
        inputTokens: 0, outputTokens: 0, thinkingTokens: 0,
        inputImages: 0, outputImages: 0,
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
        latencyP95Ms: null,
        inputTokens: data.inputTokens,
        outputTokens: data.outputTokens,
        thinkingTokens: data.thinkingTokens,
        inputImages: data.inputImages,
        outputImages: data.outputImages,
      };
    })
    .sort((a, b) => b.totalRequests - a.totalRequests);
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
