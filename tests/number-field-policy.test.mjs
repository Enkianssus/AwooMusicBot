import test from 'node:test';
import assert from 'node:assert/strict';
import {
    MAX_PORT,
    MIN_PORT,
    finiteNumberOr,
    isValidPort,
    parseNumberDraft,
    parsePortDraft
} from '../src/number-field-policy.ts';

test('an empty or non-numeric draft is invalid', () => {
    assert.deepEqual(parseNumberDraft(''), { ok: false, error: '请输入数值' });
    assert.deepEqual(parseNumberDraft('   '), { ok: false, error: '请输入数值' });
    for (const draft of ['abc', '12a', '1e3', '0x10', '--1', '1.2.3', 'NaN', 'Infinity']) {
        assert.equal(parseNumberDraft(draft).ok, false, draft);
    }
});

test('a draft is validated, never clamped while typing', () => {
    const rotation = { min: 4, max: 60 };
    assert.deepEqual(parseNumberDraft('1', rotation), { ok: false, error: '范围 4–60' });
    assert.deepEqual(parseNumberDraft('12', rotation), { ok: true, value: 12 });
    assert.deepEqual(parseNumberDraft(' 4 ', rotation), { ok: true, value: 4 });
    assert.deepEqual(parseNumberDraft('60', rotation), { ok: true, value: 60 });
    assert.deepEqual(parseNumberDraft('61', rotation), { ok: false, error: '范围 4–60' });
    assert.deepEqual(parseNumberDraft('0.35', { min: 0, max: 1 }), { ok: true, value: 0.35 });
});

test('integer rules and one-sided ranges report their own errors', () => {
    const cooldown = { min: 0, integer: true };
    assert.deepEqual(parseNumberDraft('30', cooldown), { ok: true, value: 30 });
    assert.deepEqual(parseNumberDraft('0', cooldown), { ok: true, value: 0 });
    assert.deepEqual(parseNumberDraft('1.5', cooldown), { ok: false, error: '请输入整数' });
    assert.deepEqual(parseNumberDraft('-1', cooldown), { ok: false, error: '不能小于 0' });
    assert.deepEqual(parseNumberDraft('11', { max: 10 }), { ok: false, error: '不能大于 10' });
    assert.deepEqual(parseNumberDraft('99999999999999999999', cooldown), { ok: false, error: '数值过大' });
    assert.deepEqual(parseNumberDraft('5', { min: Number.NaN, max: undefined }), { ok: true, value: 5 });
});

test('full-width digits from a Chinese IME are accepted', () => {
    assert.deepEqual(parseNumberDraft('５５５６', { integer: true }), { ok: true, value: 5556 });
    assert.deepEqual(parseNumberDraft('０。５'), { ok: true, value: 0.5 });
});

test('ports must be integers within 1024–65535', () => {
    assert.equal(MIN_PORT, 1024);
    assert.equal(MAX_PORT, 65535);
    for (const port of [1024, 5555, 65535]) assert.equal(isValidPort(port), true, String(port));
    for (const port of [0, 80, 1023, 65536, 5555.5, Number.NaN]) assert.equal(isValidPort(port), false, String(port));
    assert.deepEqual(parsePortDraft('5'), { ok: false, error: '范围 1024–65535' });
    assert.deepEqual(parsePortDraft('70000'), { ok: false, error: '范围 1024–65535' });
    assert.deepEqual(parsePortDraft(''), { ok: false, error: '请输入数值' });
    assert.deepEqual(parsePortDraft('6000'), { ok: true, value: 6000 });
});

test('the external port cannot reuse a port of the internal service', () => {
    assert.equal(isValidPort(5555, { forbid: 5555 }), false);
    assert.equal(isValidPort(5555, { forbid: [5560, 5555] }), false);
    assert.equal(isValidPort(5556, { forbid: [5555] }), true);
    assert.deepEqual(
        parsePortDraft('5555', { forbid: [5555], conflictMessage: '与内部控制服务端口冲突' }),
        { ok: false, error: '与内部控制服务端口冲突' }
    );
    assert.deepEqual(parsePortDraft('5555', { forbid: 5555 }), { ok: false, error: '端口已被占用' });
    assert.deepEqual(parsePortDraft('5556', { forbid: [5555] }), { ok: true, value: 5556 });
});

test('MinMedalLevel rejects NaN and shows 0 when the stored value is not finite', () => {
    const medal = { min: 0, max: 40, integer: true };
    assert.equal(parseNumberDraft('NaN', medal).ok, false);
    assert.equal(parseNumberDraft('', medal).ok, false);
    assert.deepEqual(parseNumberDraft('41', medal), { ok: false, error: '范围 0–40' });
    assert.deepEqual(parseNumberDraft('40', medal), { ok: true, value: 40 });
    for (const stored of [Number.NaN, null, undefined, '', 'abc', Number.POSITIVE_INFINITY]) {
        assert.equal(finiteNumberOr(stored, 0), 0, String(stored));
    }
    assert.equal(finiteNumberOr(12, 0), 12);
    assert.equal(finiteNumberOr('12', 0), 12);
});
