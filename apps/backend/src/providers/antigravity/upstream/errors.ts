export interface GoogleApiError {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: Array<{
      "@type": string;
      reason?: string;
      domain?: string;
      metadata?: Record<string, string>;
      errorInfo?: {
        reason: string;
      };
      validation_url?: string;
    }>;
  };
}

/**
 * Mengurai body error Google agar routing retry dan cooldown tetap konsisten.
 */
export function parseGoogleError(body: string): {
  reason: string;
  validationUrl?: string;
  isQuotaExhausted: boolean;
  isChallengeRequired: boolean;
  isModelUnsupported: boolean;
  status: number;
  message?: string;
} {
  let reason = "unknown_error";
  let validationUrl: string | undefined;
  let isQuotaExhausted = false;
  let isChallengeRequired = false;
  let isModelUnsupported = false;
  let status = 500;
  let message: string | undefined;

  try {
    const json: GoogleApiError = JSON.parse(body);
    const error = json.error;

    if (error) {
      message = error.message;

      if (error.status === "RESOURCE_EXHAUSTED" || error.message?.includes("quota")) {
        isQuotaExhausted = true;
        reason = "quota_exhausted";
        status = 429;
      }

      if (error.message?.includes("VALIDATION_REQUIRED")) {
        isChallengeRequired = true;
        reason = "validation_required";
        status = 403;
      }

      if (error.message?.includes("Gemini Code Assist license") || error.message?.includes("SUBSCRIPTION_REQUIRED")) {
        isChallengeRequired = true;
        reason = "subscription_required";
        status = 403;
      }

      if (error.status === "NOT_FOUND" || error.message?.includes("not found") || error.message?.includes("not supported")) {
        isModelUnsupported = true;
        reason = "model_not_found";
        status = 404;
      }

      if (error.details) {
        for (const detail of error.details) {
          if (detail.reason === "VALIDATION_REQUIRED" || detail.errorInfo?.reason === "VALIDATION_REQUIRED") {
            isChallengeRequired = true;
            reason = "validation_required";
            status = 403;
            if (detail.validation_url) validationUrl = detail.validation_url;
            if (detail.metadata?.validation_url) validationUrl = detail.metadata.validation_url;
          }

          if (detail.reason === "RATE_LIMIT_EXCEEDED") {
            isQuotaExhausted = true;
            reason = "quota_exhausted";
            status = 429;
          }
        }
      }
    }
  } catch {
    if (body.includes("automated queries")) {
      isQuotaExhausted = true;
      reason = "quota_exhausted";
      status = 429;
    }
  }

  return { reason, validationUrl, isQuotaExhausted, isChallengeRequired, isModelUnsupported, status };
}
