import React from 'react';
import { Box, Text } from 'ink';

interface ErrorDisplayProps {
  error: string;
  /** Context label like "metrics", "traces", "logs" */
  context?: string;
  /** Show retry hint (press 'r') */
  showRetry?: boolean;
  /** Show back hint (press Esc) */
  showBack?: boolean;
}

/** Classify an error string into a category for user-friendly display */
function classifyError(error: string): 'auth' | 'permission' | 'not-found' | 'network' | 'quota' | 'generic' {
  const lower = error.toLowerCase();

  // Authentication errors
  if (
    lower.includes('401') ||
    lower.includes('unauthenticated') ||
    lower.includes('failed to get access token') ||
    lower.includes('could not load the default credentials') ||
    lower.includes('default credentials') ||
    lower.includes('not authenticated') ||
    lower.includes('login required') ||
    lower.includes('invalid_grant') ||
    lower.includes('token has been expired') ||
    lower.includes('refresh token') ||
    lower.includes('application default credentials')
  ) {
    return 'auth';
  }

  // Permission errors
  if (
    lower.includes('403') ||
    lower.includes('permission') ||
    lower.includes('forbidden') ||
    lower.includes('access denied') ||
    lower.includes('caller does not have permission')
  ) {
    return 'permission';
  }

  // Not found (wrong project, API not enabled)
  if (
    lower.includes('404') ||
    lower.includes('not found') ||
    lower.includes('api not enabled') ||
    lower.includes('has not been used') ||
    lower.includes('is not enabled')
  ) {
    return 'not-found';
  }

  // Network errors
  if (
    lower.includes('enotfound') ||
    lower.includes('econnrefused') ||
    lower.includes('econnreset') ||
    lower.includes('etimedout') ||
    lower.includes('network') ||
    lower.includes('fetch failed') ||
    lower.includes('dns') ||
    lower.includes('socket')
  ) {
    return 'network';
  }

  // Quota / rate limit
  if (
    lower.includes('429') ||
    lower.includes('quota') ||
    lower.includes('rate limit') ||
    lower.includes('resource exhausted')
  ) {
    return 'quota';
  }

  return 'generic';
}

/**
 * A shared error display component that provides context-aware error messages
 * with actionable instructions for common GCP auth/permission issues.
 */
export function ErrorDisplay({ error, context, showRetry = true, showBack = false }: ErrorDisplayProps) {
  const category = classifyError(error);
  const contextLabel = context ? ` loading ${context}` : '';

  return (
    <Box flexDirection="column">
      {category === 'auth' && (
        <>
          <Text color="red" bold>✗ Authentication Error</Text>
          <Text color="red" dimColor>{error}</Text>
          <Text />
          <Text>Your Google Cloud credentials are missing or expired.</Text>
          <Text>Run this command to authenticate:</Text>
          <Text />
          <Text bold color="cyan">  gcloud auth application-default login</Text>
          <Text />
          <Text dimColor>Then restart genkit-gcp-goggles.</Text>
          <Text dimColor>If using a service account, set GOOGLE_APPLICATION_CREDENTIALS.</Text>
        </>
      )}

      {category === 'permission' && (
        <>
          <Text color="red" bold>✗ Permission Denied</Text>
          <Text color="red" dimColor>{error}</Text>
          <Text />
          <Text>Your account doesn't have the required permissions.</Text>
          <Text>Ensure your account has these IAM roles on the project:</Text>
          <Text />
          <Text bold color="cyan">  roles/monitoring.viewer</Text>
          <Text bold color="cyan">  roles/cloudtrace.user</Text>
          <Text bold color="cyan">  roles/logging.viewer</Text>
          <Text />
          <Text dimColor>Grant roles with:</Text>
          <Text dimColor>  gcloud projects add-iam-policy-binding PROJECT_ID \</Text>
          <Text dimColor>    --member="user:YOUR_EMAIL" \</Text>
          <Text dimColor>    --role="roles/monitoring.viewer"</Text>
        </>
      )}

      {category === 'not-found' && (
        <>
          <Text color="red" bold>✗ Not Found{contextLabel}</Text>
          <Text color="red" dimColor>{error}</Text>
          <Text />
          <Text>This could mean:</Text>
          <Text>  • The project ID is incorrect</Text>
          <Text>  • The required API is not enabled</Text>
          <Text />
          <Text dimColor>Enable required APIs:</Text>
          <Text bold color="cyan">  gcloud services enable monitoring.googleapis.com --project PROJECT_ID</Text>
          <Text bold color="cyan">  gcloud services enable cloudtrace.googleapis.com --project PROJECT_ID</Text>
          <Text bold color="cyan">  gcloud services enable logging.googleapis.com --project PROJECT_ID</Text>
        </>
      )}

      {category === 'network' && (
        <>
          <Text color="red" bold>✗ Network Error{contextLabel}</Text>
          <Text color="red" dimColor>{error}</Text>
          <Text />
          <Text>Could not connect to Google Cloud APIs.</Text>
          <Text>Check your internet connection and try again.</Text>
        </>
      )}

      {category === 'quota' && (
        <>
          <Text color="yellow" bold>⚠ Rate Limited{contextLabel}</Text>
          <Text color="yellow" dimColor>{error}</Text>
          <Text />
          <Text>You've hit a Google Cloud API quota limit.</Text>
          <Text>Wait a moment and try again.</Text>
        </>
      )}

      {category === 'generic' && (
        <>
          <Text color="red" bold>✗ Error{contextLabel}</Text>
          <Text color="red">{error}</Text>
        </>
      )}

      {/* Action hints */}
      {(showRetry || showBack) && (
        <Box marginTop={1}>
          <Text dimColor>
            {showRetry && showBack
              ? "Press 'r' to retry, Esc to go back"
              : showRetry
                ? "Press 'r' to retry"
                : "Press Esc to go back"}
          </Text>
        </Box>
      )}
    </Box>
  );
}

/**
 * Inline error hint for non-critical errors (e.g., logs failed but trace still visible).
 * Shows a compact one-line error with context-aware hint.
 */
export function InlineError({ error, context }: { error: string; context?: string }) {
  const category = classifyError(error);
  const contextLabel = context || 'data';

  if (category === 'auth') {
    return (
      <Text color="red">⚠ Auth error loading {contextLabel} - run: gcloud auth application-default login</Text>
    );
  }
  if (category === 'permission') {
    return (
      <Text color="red">⚠ Permission denied loading {contextLabel} - check IAM roles</Text>
    );
  }
  return (
    <Text color="red">⚠ Error loading {contextLabel}: {error.length > 80 ? error.slice(0, 77) + '…' : error}</Text>
  );
}
