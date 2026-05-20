export type TimeRangePreset = '1h' | '6h' | '24h' | '7d' | '30d';

export interface TimeRange {
  startTime: string;
  endTime: string;
  preset: TimeRangePreset;
}

export function createTimeRange(preset: TimeRangePreset): TimeRange {
  const endTime = new Date().toISOString();
  const durations: Record<TimeRangePreset, number> = {
    '1h': 60 * 60 * 1000,
    '6h': 6 * 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
  };
  const startTime = new Date(Date.now() - durations[preset]).toISOString();
  return { startTime, endTime, preset };
}

export type Screen =
  | { type: 'overview' }
  | { type: 'feature'; featureName: string }
  | { type: 'trace'; traceId: string; featureName?: string };

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

export function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

export function formatTime(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const month = d.toLocaleString('en', { month: 'short' });
  const day = d.getDate();
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  const s = d.getSeconds().toString().padStart(2, '0');
  return `${month} ${day} ${h}:${m}:${s}`;
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
