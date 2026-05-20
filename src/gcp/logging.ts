import { getAccessToken } from './auth.js';

const LOGGING_BASE = 'https://logging.googleapis.com/v2';

interface LogEntry {
  logName: string;
  timestamp: string;
  jsonPayload?: Record<string, any>;
  textPayload?: string;
  trace?: string;
  spanId?: string;
  labels?: Record<string, string>;
}

interface ListLogEntriesResponse {
  entries?: LogEntry[];
  nextPageToken?: string;
}

/** Input/output content extracted from Cloud Logging for a specific span */
export interface SpanIOFromLogs {
  input?: string;
  output?: string;
}

/**
 * Fetch all log entries correlated with a specific trace.
 * Genkit writes input/output to Cloud Logging (not trace span labels),
 * using `logging.googleapis.com/trace` and `logging.googleapis.com/spanId`
 * for correlation. The actual content is in `jsonPayload.content`.
 *
 * Log messages are prefixed with "Input[...]" or "Output[...]".
 */
export async function fetchTraceLogEntries(
  projectId: string,
  traceId: string
): Promise<Map<string, SpanIOFromLogs>> {
  const token = await getAccessToken();

  const spanIOMap = new Map<string, SpanIOFromLogs>();
  let pageToken: string | undefined;

  do {
    // Cloud Logging promotes logging.googleapis.com/trace to the top-level `trace` field,
    // so we only need to filter on the promoted field (faster than OR with jsonPayload)
    const traceResource = `projects/${projectId}/traces/${traceId}`;
    const body: Record<string, any> = {
      resourceNames: [`projects/${projectId}`],
      filter: `trace="${traceResource}"`,
      orderBy: 'timestamp asc',
      pageSize: 200,
    };
    if (pageToken) {
      body.pageToken = pageToken;
    }

    const response = await fetch(`${LOGGING_BASE}/entries:list`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Cloud Logging API error (${response.status}): ${error}`);
    }

    const data = (await response.json()) as ListLogEntriesResponse;
    const entries = data.entries || [];

    for (const entry of entries) {
      const payload = entry.jsonPayload;
      if (!payload) continue;

      // spanId is promoted to top-level by Cloud Logging
      const spanId = entry.spanId || payload['logging.googleapis.com/spanId'] || '';
      if (!spanId) continue;

      // Content is nested under metadata.content in Genkit's log structure
      const content = payload.metadata?.content || payload.content;
      if (!content) continue;

      // Determine if this is an Input or Output log from the message field
      // Genkit prefixes messages with "[genkit] "
      const message = payload.message || '';
      const isInput = message.includes('Input[');
      const isOutput = message.includes('Output[');

      // For generate telemetry, logs may also have role/partIndex fields
      // We'll concatenate multi-part messages
      if (isInput || isOutput) {
        const existing = spanIOMap.get(spanId) || {};

        if (isInput) {
          // Append for multi-part inputs (generate actions split by parts/messages)
          existing.input = existing.input
            ? existing.input + '\n' + content
            : content;
        }
        if (isOutput) {
          existing.output = existing.output
            ? existing.output + '\n' + content
            : content;
        }

        spanIOMap.set(spanId, existing);
      }
    }

    pageToken = data.nextPageToken;
  } while (pageToken);

  return spanIOMap;
}

/**
 * Fetch the root span's input content for multiple traces at once.
 * Used for the trace list preview in the feature detail screen.
 * Returns a map of traceId → input string.
 */
export async function fetchTraceInputsForList(
  projectId: string,
  traceIds: string[]
): Promise<Map<string, string>> {
  if (traceIds.length === 0) return new Map();

  const token = await getAccessToken();
  const result = new Map<string, string>();

  // Build an OR filter for all trace IDs
  const traceFilters = traceIds
    .map((id) => `jsonPayload."logging.googleapis.com/trace"="projects/${projectId}/traces/${id}"`)
    .join(' OR ');

  // Only fetch Input logs to keep it efficient
  const filter = `(${traceFilters}) AND jsonPayload.message=~"^Input\\["`;

  let pageToken: string | undefined;

  do {
    const body: Record<string, any> = {
      resourceNames: [`projects/${projectId}`],
      filter,
      orderBy: 'timestamp asc',
      pageSize: 500,
    };
    if (pageToken) {
      body.pageToken = pageToken;
    }

    const response = await fetch(`${LOGGING_BASE}/entries:list`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      // Non-critical: if logging fails, we just don't show input previews
      break;
    }

    const data = (await response.json()) as ListLogEntriesResponse;
    const entries = data.entries || [];

    for (const entry of entries) {
      const payload = entry.jsonPayload;
      if (!payload) continue;

      const traceRef = payload['logging.googleapis.com/trace'] as string;
      if (!traceRef) continue;

      // Extract traceId from "projects/{projectId}/traces/{traceId}"
      const traceId = traceRef.split('/traces/')[1];
      if (!traceId) continue;

      const content = payload.content;
      if (!content) continue;

      // Only keep the first input per trace (root span's input)
      if (!result.has(traceId)) {
        result.set(traceId, content);
      }
    }

    pageToken = data.nextPageToken;
  } while (pageToken);

  return result;
}
