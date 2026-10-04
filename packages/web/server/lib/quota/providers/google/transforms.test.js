import { describe, expect, it } from 'vitest';
import {
  parseGoogleRefreshToken,
  resolveGoogleWindow,
  transformModelData,
  transformQuotaBucket
} from './transforms.js';

describe('Google Provider transforms', () => {
  it('parses composite refresh tokens containing project ID', () => {
    const parsed = parseGoogleRefreshToken('my-token|project-123|managed-456');
    expect(parsed.refreshToken).toBe('my-token');
    expect(parsed.projectId).toBe('project-123');
    expect(parsed.managedProjectId).toBe('managed-456');
  });

  it('resolves daily window for standard Gemini CLI sources', () => {
    const window = resolveGoogleWindow('gemini', Date.now() + 3600 * 1000);
    expect(window.label).toBe('daily');
    expect(window.seconds).toBe(24 * 60 * 60);
  });

  it('transforms model quota data correctly', () => {
    const transformed = transformModelData('gemini-2.5-pro', {
      quotaInfo: {
        remainingFraction: 0.8,
        resetTime: '2026-10-05T00:00:00Z'
      }
    }, 'gemini');

    expect(transformed['gemini/gemini-2.5-pro']).toBeDefined();
    expect(transformed['gemini/gemini-2.5-pro'].windows.daily.remainingPercent).toBe(80);
    expect(transformed['gemini/gemini-2.5-pro'].windows.daily.usedPercent).toBe(20);
  });
});
