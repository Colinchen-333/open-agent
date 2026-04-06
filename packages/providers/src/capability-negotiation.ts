/**
 * Runtime capability negotiation — query providers for actual capabilities
 * and merge with static registry defaults.
 */

import type { ModelCapability } from './model-capability.js';
import { getModelCapability } from './model-capability.js';

/** Capabilities that a provider can report at runtime */
export interface NegotiatedCapabilities {
  supportsThinking: boolean;
  supportsVision: boolean;
  supportsPromptCaching: boolean;
  maxContextWindow?: number;
  maxOutputTokens?: number;
  /** Model version/revision returned by the provider */
  modelVersion?: string;
  /** Whether the provider confirmed the model exists */
  modelAvailable: boolean;
}

/** Provider probe result */
export interface ProbeResult {
  available: boolean;
  capabilities?: Partial<NegotiatedCapabilities>;
  error?: string;
  latencyMs: number;
}

/**
 * Probe a provider endpoint to check model availability.
 * This is a lightweight health check, not a full query.
 */
export async function probeProvider(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  headers?: Record<string, string>;
}): Promise<ProbeResult> {
  const t0 = performance.now();
  try {
    // Try models/list endpoint first (OpenAI-compatible)
    const res = await fetch(`${opts.baseUrl}/models`, {
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        ...opts.headers,
      },
      signal: AbortSignal.timeout(5000),
    });

    const latencyMs = Math.round(performance.now() - t0);

    if (!res.ok) {
      return { available: false, error: `HTTP ${res.status}`, latencyMs };
    }

    const data = (await res.json()) as { data?: Array<{ id: string }> };
    const models = data.data ?? [];
    const found = models.some(
      (m: { id: string }) => m.id === opts.model || m.id.includes(opts.model),
    );

    return {
      available: found,
      latencyMs,
      capabilities: found ? { modelAvailable: true } : { modelAvailable: false },
    };
  } catch (err: any) {
    return {
      available: false,
      error: err.message ?? String(err),
      latencyMs: Math.round(performance.now() - t0),
    };
  }
}

/** Conservative fallback for models not in the static registry. */
const FALLBACK_CAPABILITY: ModelCapability = {
  contextWindow: 200_000,
  maxOutput: 4096,
  supportsThinking: false,
  supportsVision: false,
  supportsPromptCaching: false,
};

/**
 * Merge static registry capabilities with runtime probe results.
 * Runtime values override static when present.
 */
export function mergeCapabilities(
  model: string,
  probeResult?: Partial<NegotiatedCapabilities>,
): ModelCapability {
  const base = getModelCapability(model) ?? FALLBACK_CAPABILITY;

  if (!probeResult) return { ...base };

  return {
    ...base,
    supportsThinking: probeResult.supportsThinking ?? base.supportsThinking,
    supportsVision: probeResult.supportsVision ?? base.supportsVision,
    supportsPromptCaching: probeResult.supportsPromptCaching ?? base.supportsPromptCaching,
    ...(probeResult.maxContextWindow != null
      ? { contextWindow: probeResult.maxContextWindow }
      : {}),
    ...(probeResult.maxOutputTokens != null
      ? { maxOutput: probeResult.maxOutputTokens }
      : {}),
  };
}
