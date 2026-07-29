export type PendingResumeSubmitOptions = {
  resumePendingConfirmation?: boolean;
  isAutoNetworkRetry?: boolean;
};

/**
 * Renderer-only eligibility state. It stores exact failed composer text, never a
 * preview token. Main remains authoritative for pending-token validity.
 */
export class PendingResumeEligibility {
  private failedComposerText: string | null = null;

  canResume(composerText: string): boolean {
    return this.failedComposerText !== null && composerText === this.failedComposerText;
  }

  beginTurn(composerText: string, options: PendingResumeSubmitOptions): void {
    void composerText;
    if (options.isAutoNetworkRetry === true) return;
    if (options.resumePendingConfirmation !== true) {
      this.clear();
    }
  }

  recordFailure(composerText: string, associatedWithPendingConfirmation: boolean): void {
    this.failedComposerText = associatedWithPendingConfirmation ? composerText : null;
  }

  clear(): void {
    this.failedComposerText = null;
  }
}

/** Preserve an explicit resume decision across the one automatic retry; never infer it. */
export function autoNetworkRetryOptions(
  options: PendingResumeSubmitOptions,
): Required<PendingResumeSubmitOptions> {
  return {
    resumePendingConfirmation: options.resumePendingConfirmation === true,
    isAutoNetworkRetry: true,
  };
}
