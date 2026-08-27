import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkFeedbackSubmissionEvidence,
  isTechnicalFeedbackCategory
} from '../src/feedback-submission-policy.ts';

function ready(overrides = {}) {
  return {
    category: 'bug',
    updatesRetried: true,
    reproductionConfirmed: true,
    includeDiagnostics: true,
    includeLogs: true,
    diagnosticsLoaded: true,
    logsCapturedAfterReproduction: true,
    ...overrides
  };
}

test('classifies technical categories and leaves suggestions optional', () => {
  assert.equal(isTechnicalFeedbackCategory('bug'), true);
  assert.equal(isTechnicalFeedbackCategory('connector'), true);
  assert.equal(isTechnicalFeedbackCategory('compatibility'), true);
  assert.equal(isTechnicalFeedbackCategory('feature'), false);
  assert.equal(isTechnicalFeedbackCategory('other'), false);
  assert.deepEqual(checkFeedbackSubmissionEvidence({
    ...ready(),
    category: 'feature',
    updatesRetried: false,
    reproductionConfirmed: false,
    includeDiagnostics: false,
    includeLogs: false,
    diagnosticsLoaded: false,
    logsCapturedAfterReproduction: false
  }), { allowed: true });
});

test('requires update acknowledgement and a same-session reproduction', () => {
  assert.match(
    checkFeedbackSubmissionEvidence(ready({ updatesRetried: false })).message,
    /更新播放器、连接器和嗷呜点歌机/
  );
  assert.match(
    checkFeedbackSubmissionEvidence(ready({ reproductionConfirmed: false })).message,
    /本次点歌机运行期间复现/
  );
});

test('requires diagnostics and fresh sanitized logs for technical reports', () => {
  assert.match(
    checkFeedbackSubmissionEvidence(ready({ includeDiagnostics: false })).message,
    /必须附带诊断信息/
  );
  assert.match(
    checkFeedbackSubmissionEvidence(ready({ includeLogs: false })).message,
    /最近的脱敏运行日志/
  );
  assert.match(
    checkFeedbackSubmissionEvidence(ready({ diagnosticsLoaded: false })).message,
    /还没有准备好/
  );
  assert.match(
    checkFeedbackSubmissionEvidence(ready({ logsCapturedAfterReproduction: false })).message,
    /复现后的最新脱敏日志/
  );
  assert.equal(checkFeedbackSubmissionEvidence(ready()).allowed, true);
});
