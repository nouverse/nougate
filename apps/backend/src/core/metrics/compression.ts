import type { CompressionStats } from '@/core/metrics/tracker';
import type { CompressionReport } from '@/core/compressor';
import { estimatePayloadTokens } from '@/core/metrics/tokenizer';
import { applyRtk } from '@/core/rtk';
import { compressPayload } from '@/core/compressor';

export interface PreparedPayload {
  body: any;
  compression: CompressionStats;
}

/**
 * Run the request through RTK then Headroom, measuring what the two passes
 * saved so the dashboard can show compression ROI.
 *
 * Savings are the payload delta across both passes (estimated at ~4 chars per
 * token). When Headroom reports its own `tokens_saved` and that number is
 * larger, it wins — it counts semantic rewrites the size delta understates.
 */
export async function prepareRequestPayload(body: any): Promise<PreparedPayload> {
  const tokensBefore = estimatePayloadTokens(body);

  const rtkBody = applyRtk(body);
  const report: CompressionReport = {};
  const compressedBody = await compressPayload(rtkBody, report);

  const tokensAfter = estimatePayloadTokens(compressedBody);
  const measuredSaved = Math.max(0, tokensBefore - tokensAfter);
  const tokensSaved = Math.max(measuredSaved, report.tokensSaved ?? 0);

  return {
    body: compressedBody,
    compression: {
      tokensBefore,
      tokensAfter,
      tokensSaved,
    },
  };
}
