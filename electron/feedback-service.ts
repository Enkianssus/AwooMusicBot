const FEEDBACK_API_URL =
  'https://app.enkianss.us/api/v1/feedback';

export interface FeedbackSubmission {
  category: string;
  priority: string;
  title: string;
  description: string;
  contact?: string;
  appVersion?: string;
  coreVersion?: string;
  platform?: string;
  architecture?: string;
  osVersion?: string;
  selectedPlayer?: string;
  playerVersion?: string;
  connectorId?: string;
  connectorVersion?: string;
  latestConnectorVersion?: string;
  connectionStatus?: string;
  diagnostics?: Record<string, unknown>;
}

export interface FeedbackSubmitResult {
  success: boolean;
  id: string;
  status: string;
  trackingUrl: string;
}

export async function submitFeedback(
  submission: FeedbackSubmission,
  timeoutMs = 12_000
): Promise<FeedbackSubmitResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(FEEDBACK_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'AwooMusicBot-Feedback/1.1'
      },
      body: JSON.stringify({
        ...submission,
        source: 'app'
      }),
      signal: controller.signal
    });
    const result = await response.json() as Record<string, any>;
    if (!response.ok || !result.success) {
      throw new Error(
        String(result.error || `反馈服务 HTTP ${response.status}`)
      );
    }
    return result as FeedbackSubmitResult;
  } finally {
    clearTimeout(timer);
  }
}

export function sanitizeFeedbackLog(message: string): string {
  return String(message)
    .replace(
      /(SESSDATA|bili_jct|buvid\w*|access[_-]?token|refresh[_-]?token|cookie|authorization)(\s*[:=]\s*)[^\s;,]+/gi,
      '$1$2[已隐藏]'
    )
    .replace(
      /([?&](?:token|access_token|csrf|sessdata)=)[^&\s]+/gi,
      '$1[已隐藏]'
    )
    .slice(0, 1200);
}
