import { GoogleAuth } from 'google-auth-library';

const SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/monitoring.read',
  'https://www.googleapis.com/auth/trace.readonly',
];

let authInstance: GoogleAuth | null = null;

function getAuth(): GoogleAuth {
  if (!authInstance) {
    authInstance = new GoogleAuth({ scopes: SCOPES });
  }
  return authInstance;
}

export async function getAuthClient() {
  return getAuth().getClient();
}

export async function getProjectId(): Promise<string | undefined> {
  try {
    const projectId = await getAuth().getProjectId();
    return projectId || undefined;
  } catch {
    return undefined;
  }
}

export async function getAccessToken(): Promise<string> {
  const client = await getAuthClient();
  const token = await client.getAccessToken();
  if (!token.token) {
    throw new Error(
      'Failed to get access token. Run: gcloud auth application-default login'
    );
  }
  return token.token;
}

export async function checkAuth(): Promise<{
  authenticated: boolean;
  projectId?: string;
  error?: string;
}> {
  try {
    const client = await getAuthClient();
    const projectId = await getProjectId();
    const credentials = await client.getAccessToken();
    return {
      authenticated: !!credentials.token,
      projectId: projectId || undefined,
    };
  } catch (err) {
    return {
      authenticated: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}
