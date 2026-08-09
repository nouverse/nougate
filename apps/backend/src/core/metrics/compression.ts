import type { CompressionStats } from '@/core/metrics/tracker';
import type { CompressionReport } from '@/core/compressor';
import { getProxyConfig } from '@/config/manager';
import { estimatePayloadTokens } from '@/core/metrics/tokenizer';
import { applyRtk } from '@/core/rtk';
import { compressPayload } from '@/core/compressor';

export interface PreparedPayload {
  body: any;
  compression: CompressionStats;
}

/**
 * Whether an engine is switched on, read defensively — config may be unloaded
 * in scripts and tests.
 */
function isEnabled(read: (config: ReturnType<typeof getProxyConfig>) => boolean): boolean {
  try {
    return read(getProxyConfig());
  } catch {
    return false;
  }
}

/**
 * Run the request through the compression pipeline, measuring each stage
 * separately so the dashboard can say *which* engine saved what.
 *
 * The payload is re-measured between passes rather than once at each end: a
 * single before/after delta can only ever report a total, which leaves "is RTK
 * actually earning its place?" unanswerable. Estimation is ~4 chars per token,
 * so these are approximations — but they are consistent approximations, and the
 * share between engines is what the number is for.
 *
 * An engine that ran and saved nothing is still reported, at 0. That is a
 * different fact from an engine being switched off, and collapsing the two
 * would hide a filter that has stopped matching anything.
 */
export async function prepareRequestPayload(body: any): Promise<PreparedPayload> {
  const byEngine: CompressionStats['byEngine'] = [];

  const tokensBefore = estimatePayloadTokens(body);

  const rtkEnabled = isEnabled((config) => config.rtk?.enabled === true);
  const rtkBody = applyRtk(body);
  const afterRtk = rtkEnabled ? estimatePayloadTokens(rtkBody) : tokensBefore;
  if (rtkEnabled) {
    byEngine.push({ engine: 'rtk', tokensSaved: Math.max(0, tokensBefore - afterRtk) });
  }

  const headroomEnabled = isEnabled((config) => config.headroom?.enabled === true);
  const report: CompressionReport = {};
  const compressedBody = await compressPayload(rtkBody, report);
  const tokensAfter = headroomEnabled ? estimatePayloadTokens(compressedBody) : afterRtk;
  if (headroomEnabled) {
    // Headroom reports its own figure, which counts semantic rewrites that a
    // size delta understates. Whichever is larger is the honest one.
    const measured = Math.max(0, afterRtk - tokensAfter);
    byEngine.push({ engine: 'headroom', tokensSaved: Math.max(measured, report.tokensSaved ?? 0) });
  }

  // The total is the sum of the attributed parts, so the breakdown always adds
  // up to the headline figure rather than leaving an unexplained remainder.
  const tokensSaved = byEngine.reduce((total, entry) => total + entry.tokensSaved, 0);

  return {
    body: compressedBody,
    compression: {
      tokensBefore,
      tokensAfter,
      tokensSaved,
      byEngine,
    },
  };
}
