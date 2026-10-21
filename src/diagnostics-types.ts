export type DiagnosticStatus = 'pass' | 'warning' | 'error' | 'unknown';
export type DiagnosticRepair = 'reconnect-room' | 'reconnect-player' | 'update-connector';

export interface DiagnosticCheck {
  id: string;
  title: string;
  status: DiagnosticStatus;
  message: string;
  advice?: string;
  repair?: DiagnosticRepair;
}

export interface DiagnosticReport {
  checkedAt: number;
  playerKey: string;
  playerLabel: string;
  roomId: number;
  checks: DiagnosticCheck[];
}

export interface DanmakuReceptionTest {
  status: 'idle' | 'waiting' | 'received' | 'timeout' | 'cancelled';
  phrase: string;
  roomId: number;
  startedAt: number;
  expiresAt: number;
  receivedAt: number | null;
}

export interface DiagnosticsState {
  busy: boolean;
  phase: string;
  report: DiagnosticReport | null;
  reception: DanmakuReceptionTest;
  repairResults: { action: DiagnosticRepair; success: boolean; message: string }[];
  error: string;
}
