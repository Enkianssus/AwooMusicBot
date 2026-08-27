export const TECHNICAL_FEEDBACK_CATEGORIES = [
  'bug',
  'connector',
  'compatibility'
] as const;

export function isTechnicalFeedbackCategory(category: string): boolean {
  return (TECHNICAL_FEEDBACK_CATEGORIES as readonly string[]).includes(category);
}

export interface FeedbackEvidenceState {
  category: string;
  updatesRetried: boolean;
  reproductionConfirmed: boolean;
  includeDiagnostics: boolean;
  includeLogs: boolean;
  diagnosticsLoaded: boolean;
  logsCapturedAfterReproduction: boolean;
}

export interface FeedbackSubmissionCheck {
  allowed: boolean;
  message?: string;
}

/**
 * Technical reports should be submitted only after the standard update path
 * and one fresh reproduction.  Keeping this as a pure policy makes the UI
 * guard testable and prevents a future form change from silently dropping
 * the evidence requirements.
 */
export function checkFeedbackSubmissionEvidence(
  state: FeedbackEvidenceState
): FeedbackSubmissionCheck {
  if (!isTechnicalFeedbackCategory(state.category)) {
    return { allowed: true };
  }

  if (!state.updatesRetried) {
    return {
      allowed: false,
      message: '请先更新播放器、连接器和嗷呜点歌机，重试后仍有问题再提交。'
    };
  }
  if (!state.reproductionConfirmed) {
    return {
      allowed: false,
      message: '请在本次点歌机运行期间复现一次问题，再提交反馈。'
    };
  }
  if (!state.includeDiagnostics) {
    return {
      allowed: false,
      message: '技术问题必须附带诊断信息，不能关闭诊断信息后提交。'
    };
  }
  if (!state.includeLogs) {
    return {
      allowed: false,
      message: '技术问题必须附带最近的脱敏运行日志，不能关闭日志后提交。'
    };
  }
  if (!state.diagnosticsLoaded) {
    return {
      allowed: false,
      message: '诊断信息还没有准备好，请等待加载完成后再提交。'
    };
  }
  if (!state.logsCapturedAfterReproduction) {
    return {
      allowed: false,
      message: '请勾选复现确认，让点歌机先抓取复现后的最新脱敏日志。'
    };
  }

  return { allowed: true };
}
