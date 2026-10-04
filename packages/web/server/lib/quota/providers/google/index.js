import { readOpenCodeCredentials } from '../../../opencode/auth.js';
import { buildResult } from '../../utils/index.js';
import {
  resolveGoogleAuthSources,
  resolveGoogleOAuthClient,
  DEFAULT_PROJECT_ID
} from './auth.js';
import {
  transformQuotaBucket,
  transformModelData,
  transformQuotaSummary,
  applySummaryToModels
} from './transforms.js';
import {
  refreshGoogleAccessToken,
  fetchGoogleQuotaBuckets,
  fetchGoogleModels,
  fetchGoogleQuotaSummary
} from './api.js';

export { resolveGoogleAuthSources } from './auth.js';

export const providerId = 'google';
export const providerName = 'Google';
export const aliases = ['google', 'google.oauth'];

export const isConfigured = (auth) => resolveGoogleAuthSources(auth).length > 0;

export const fetchGoogleQuota = async () => {
  const authSources = resolveGoogleAuthSources(await readOpenCodeCredentials());
  if (!authSources.length) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured'
    });
  }

  const models = {};
  const topWindows = {};
  const sourceErrors = [];

  for (const source of authSources) {
    const now = Date.now();
    let accessToken = source.accessToken;

    if (!accessToken || (typeof source.expires === 'number' && source.expires <= now)) {
      if (!source.refreshToken) {
        sourceErrors.push(`${source.sourceLabel}: Missing refresh token`);
        continue;
      }
      const { clientId, clientSecret } = resolveGoogleOAuthClient(source.sourceId);
      accessToken = await refreshGoogleAccessToken(source.refreshToken, clientId, clientSecret);
    }

    if (!accessToken) {
      sourceErrors.push(`${source.sourceLabel}: Failed to refresh OAuth token`);
      continue;
    }

    const projectId = source.projectId ?? DEFAULT_PROJECT_ID;
    let mergedAnyModel = false;

    if (source.sourceId === 'gemini') {
      const quotaPayload = await fetchGoogleQuotaBuckets(accessToken, projectId);
      const buckets = Array.isArray(quotaPayload?.buckets) ? quotaPayload.buckets : [];

      for (const bucket of buckets) {
        const transformed = transformQuotaBucket(bucket, source.sourceId);
        if (transformed) {
          Object.assign(models, transformed);
          mergedAnyModel = true;
        }
      }
    }

    const payload = await fetchGoogleModels(accessToken, projectId);
    if (payload) {
      for (const [modelName, modelData] of Object.entries(payload.models ?? {})) {
        const transformed = transformModelData(modelName, modelData, source.sourceId);
        Object.assign(models, transformed);
        mergedAnyModel = true;
      }
    }

    const summaryPayload = await fetchGoogleQuotaSummary(accessToken, projectId);
    if (summaryPayload) {
      const { topWindows: summaryTopWindows, modelGroupWindows } = transformQuotaSummary(summaryPayload);
      Object.assign(topWindows, summaryTopWindows);
      applySummaryToModels(models, modelGroupWindows);
    }

    if (!mergedAnyModel) {
      sourceErrors.push(`${source.sourceLabel}: Failed to fetch models`);
    }
  }

  if (!Object.keys(models).length) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: sourceErrors[0] ?? 'Failed to fetch models'
    });
  }

  return buildResult({
    providerId,
    providerName,
    ok: true,
    configured: true,
    usage: {
      windows: topWindows,
      models: Object.keys(models).length ? models : undefined
    }
  });
};
