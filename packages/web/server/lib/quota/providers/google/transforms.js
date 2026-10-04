/**
 * Google Provider - Transforms
 *
 * Data transformation functions for Google quota responses.
 * @module quota/providers/google/transforms
 */

import {
  asNonEmptyString,
  toNumber,
  toTimestamp,
  toUsageWindow
} from '../../utils/index.js';

const GOOGLE_FIVE_HOUR_WINDOW_SECONDS = 5 * 60 * 60;
const GOOGLE_DAILY_WINDOW_SECONDS = 24 * 60 * 60;
const GOOGLE_WEEKLY_WINDOW_SECONDS = 7 * 24 * 60 * 60;

export const parseGoogleRefreshToken = (rawRefreshToken) => {
  const refreshToken = asNonEmptyString(rawRefreshToken);
  if (!refreshToken) {
    return { refreshToken: null, projectId: null, managedProjectId: null };
  }

  const [rawToken = '', rawProject = '', rawManagedProject = ''] = refreshToken.split('|');
  return {
    refreshToken: asNonEmptyString(rawToken),
    projectId: asNonEmptyString(rawProject),
    managedProjectId: asNonEmptyString(rawManagedProject)
  };
};

export const resolveGoogleWindow = (sourceId, resetAt) => {
  if (sourceId === 'gemini') {
    return { label: 'daily', seconds: GOOGLE_DAILY_WINDOW_SECONDS };
  }

  if (sourceId === 'antigravity') {
    const remainingSeconds = typeof resetAt === 'number'
      ? Math.max(0, Math.round((resetAt - Date.now()) / 1000))
      : null;

    if (remainingSeconds !== null && remainingSeconds > 36 * 60 * 60) {
      return { label: 'weekly', seconds: GOOGLE_WEEKLY_WINDOW_SECONDS };
    }

    if (remainingSeconds !== null && remainingSeconds > 10 * 60 * 60) {
      return { label: 'daily', seconds: GOOGLE_DAILY_WINDOW_SECONDS };
    }

    return { label: '5h', seconds: GOOGLE_FIVE_HOUR_WINDOW_SECONDS };
  }

  return { label: 'daily', seconds: GOOGLE_DAILY_WINDOW_SECONDS };
};

export const transformQuotaBucket = (bucket, sourceId) => {
  const modelId = asNonEmptyString(bucket?.modelId);
  if (!modelId) {
    return null;
  }

  const scopedName = modelId.startsWith(`${sourceId}/`)
    ? modelId
    : `${sourceId}/${modelId}`;

  const remainingFraction = toNumber(bucket?.remainingFraction);
  const remainingPercent = remainingFraction !== null
    ? Math.round(remainingFraction * 100)
    : null;
  const usedPercent = remainingPercent !== null ? Math.max(0, 100 - remainingPercent) : null;
  const resetAt = toTimestamp(bucket?.resetTime);
  const window = resolveGoogleWindow(sourceId, resetAt);

  return {
    [scopedName]: {
      windows: {
        [window.label]: toUsageWindow({
          usedPercent,
          windowSeconds: window.seconds,
          resetAt
        })
      }
    }
  };
};

export const transformModelData = (modelName, modelData, sourceId) => {
  const scopedName = modelName.startsWith(`${sourceId}/`)
    ? modelName
    : `${sourceId}/${modelName}`;

  const remainingFraction = modelData?.quotaInfo?.remainingFraction;
  const remainingPercent = typeof remainingFraction === 'number'
    ? Math.round(remainingFraction * 100)
    : null;
  const usedPercent = remainingPercent !== null ? Math.max(0, 100 - remainingPercent) : null;
  const resetAt = modelData?.quotaInfo?.resetTime
    ? new Date(modelData.quotaInfo.resetTime).getTime()
    : null;
  const window = resolveGoogleWindow(sourceId, resetAt);

  return {
    [scopedName]: {
      windows: {
        [window.label]: toUsageWindow({
          usedPercent,
          windowSeconds: window.seconds,
          resetAt
        })
      }
    }
  };
};

export const transformQuotaSummary = (summaryPayload) => {
  const groups = Array.isArray(summaryPayload?.groups) ? summaryPayload.groups : [];
  if (!groups.length) {
    return { topWindows: {}, modelGroupWindows: [] };
  }

  const modelGroupWindows = [];
  const topWindows = {};

  for (const group of groups) {
    const groupName = (group?.displayName || '').toLowerCase();
    const is3p = groupName.includes('claude') || groupName.includes('gpt') || groupName.includes('3p');
    const groupType = is3p ? '3p' : 'gemini';

    const buckets = Array.isArray(group?.buckets) ? group.buckets : [];
    const windows = {};
    let bucket5h = null;
    let bucketWeekly = null;

    for (const bucket of buckets) {
      const remainingFraction = toNumber(bucket?.remainingFraction);
      const remainingPercent = remainingFraction !== null
        ? Math.round(remainingFraction * 100)
        : null;
      const usedPercent = remainingPercent !== null ? Math.max(0, 100 - remainingPercent) : null;
      const resetAt = toTimestamp(bucket?.resetTime);
      const windowStr = (bucket?.window || bucket?.bucketId || '').toLowerCase();

      let label = '5h';
      let seconds = GOOGLE_FIVE_HOUR_WINDOW_SECONDS;

      if (windowStr.includes('week') || windowStr.includes('7d')) {
        label = 'weekly';
        seconds = GOOGLE_WEEKLY_WINDOW_SECONDS;
        bucketWeekly = { remainingFraction: remainingFraction ?? 1, usedPercent, resetAt, seconds };
      } else if (windowStr.includes('day') || windowStr.includes('daily')) {
        label = 'daily';
        seconds = GOOGLE_DAILY_WINDOW_SECONDS;
      } else {
        label = '5h';
        seconds = GOOGLE_FIVE_HOUR_WINDOW_SECONDS;
        bucket5h = { remainingFraction: remainingFraction ?? 1, usedPercent, resetAt, seconds };
      }

      windows[label] = toUsageWindow({
        usedPercent,
        windowSeconds: seconds,
        resetAt
      });
    }

    modelGroupWindows.push({
      groupType,
      displayName: group?.displayName,
      windows,
      bucket5h,
      bucketWeekly
    });
  }

  const primaryGroup = modelGroupWindows.find((g) => g.groupType === 'gemini') ?? modelGroupWindows[0];
  if (primaryGroup) {
    Object.assign(topWindows, primaryGroup.windows);
  }

  return { topWindows, modelGroupWindows };
};

export const applySummaryToModels = (models, modelGroupWindows) => {
  if (!modelGroupWindows || !modelGroupWindows.length) {
    return models;
  }

  for (const [scopedModelName, modelEntry] of Object.entries(models)) {
    const lowerName = scopedModelName.toLowerCase();
    const is3p = lowerName.includes('claude') || lowerName.includes('gpt');
    const targetGroup = modelGroupWindows.find((g) => is3p ? g.groupType === '3p' : g.groupType === 'gemini');

    if (targetGroup && Object.keys(targetGroup.windows).length > 0) {
      const isWeeklyConstrained = targetGroup.bucketWeekly
        && (targetGroup.bucketWeekly.remainingFraction <= 0.001
          || (targetGroup.bucket5h && targetGroup.bucketWeekly.remainingFraction < targetGroup.bucket5h.remainingFraction));

      const reorderedWindows = {};
      if (isWeeklyConstrained && targetGroup.windows.weekly) {
        reorderedWindows.weekly = targetGroup.windows.weekly;
        if (targetGroup.windows['5h']) {
          reorderedWindows['5h'] = targetGroup.windows['5h'];
        }
      } else {
        if (targetGroup.windows['5h']) {
          reorderedWindows['5h'] = targetGroup.windows['5h'];
        }
        if (targetGroup.windows.weekly) {
          reorderedWindows.weekly = targetGroup.windows.weekly;
        }
      }

      for (const [wLabel, wData] of Object.entries(targetGroup.windows)) {
        if (!reorderedWindows[wLabel]) {
          reorderedWindows[wLabel] = wData;
        }
      }

      modelEntry.windows = reorderedWindows;
    }
  }

  return models;
};
