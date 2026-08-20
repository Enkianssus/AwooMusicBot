import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addGiftRequestCredits,
  canRequestWithGiftCredits,
  consumeGiftRequestCredit,
  createEmptyGiftRequestRequirements,
  giftRequestTierFromGuardLevel,
  isGiftRequestRequirementEnabled,
  matchesGiftRequestRequirement,
  normalizeGiftQuantity,
  normalizeLearnedGifts,
  normalizeGiftRequestRequirements,
  parseBilibiliGiftCreditEvent,
  rememberLearnedGift
} from '../electron/gift-request-credit-policy.ts';

test('maps Bilibili guard levels to the four configurable tiers', () => {
  assert.equal(giftRequestTierFromGuardLevel(0), 'Normal');
  assert.equal(giftRequestTierFromGuardLevel(3), 'Captain');
  assert.equal(giftRequestTierFromGuardLevel('2'), 'Admiral');
  assert.equal(giftRequestTierFromGuardLevel(1), 'Governor');
  assert.equal(giftRequestTierFromGuardLevel(undefined), 'Normal');
});

test('normalizes each gift requirement without sharing mutable defaults', () => {
  const normalized = normalizeGiftRequestRequirements({
    Normal: { GiftName: '  牛哇牛哇  ', GiftId: 123 },
    Captain: { giftName: ' 打call ', giftId: ' 456 ' },
    Admiral: 'invalid'
  });
  assert.deepEqual(normalized.Normal, {
    giftName: '牛哇牛哇',
    giftId: '123'
  });
  assert.deepEqual(normalized.Captain, {
    giftName: '打call',
    giftId: '456'
  });
  assert.deepEqual(normalized.Admiral, { giftName: '', giftId: '' });

  const first = createEmptyGiftRequestRequirements();
  const second = createEmptyGiftRequestRequirements();
  first.Normal.giftName = '辣条';
  assert.equal(second.Normal.giftName, '');
});

test('an empty tier disables the gift requirement', () => {
  const empty = { giftName: '', giftId: '' };
  assert.equal(isGiftRequestRequirementEnabled(empty), false);
  assert.equal(canRequestWithGiftCredits(empty, 0, false), true);
});

test('uses the stable gift id ahead of the display name', () => {
  const requirement = { giftName: '牛哇牛哇', giftId: '31036' };
  assert.equal(matchesGiftRequestRequirement(requirement, {
    giftName: ' 牛哇牛哇 ',
    giftId: 1
  }), false);
  assert.equal(matchesGiftRequestRequirement(requirement, {
    giftName: '别的礼物',
    giftId: 31036
  }), true);
  assert.equal(matchesGiftRequestRequirement(requirement, {
    giftName: '辣条',
    giftId: 1
  }), false);
  assert.equal(matchesGiftRequestRequirement({
    giftName: '辣条',
    giftId: ''
  }, {
    giftName: ' 辣条 ',
    giftId: 999
  }), true);
});

test('normalizes, deduplicates, and bounds the learned gift library', () => {
  const normalized = normalizeLearnedGifts([
    {
      giftName: '旧名称',
      giftId: '31036',
      lastSeenAt: 100,
      lastQuantity: 1,
      uid: 'must-not-survive',
      userName: 'must-not-survive'
    },
    {
      GiftName: '新名称',
      GiftId: 31036,
      lastSeenAt: 200,
      quantity: 5
    },
    {
      giftName: '辣条',
      giftId: '',
      lastSeenAt: 150,
      lastQuantity: 2
    },
    { giftName: '', giftId: '' }
  ], 2);

  assert.deepEqual(normalized, [
    {
      giftName: '新名称',
      giftId: '31036',
      lastSeenAt: 200,
      lastQuantity: 5
    },
    {
      giftName: '辣条',
      giftId: '',
      lastSeenAt: 150,
      lastQuantity: 2
    }
  ]);
});

test('remembering a gift updates its metadata and keeps newest gifts first', () => {
  const first = rememberLearnedGift([], {
    giftName: '牛哇牛哇',
    giftId: 31036,
    quantity: 1
  }, 100);
  const second = rememberLearnedGift(first, {
    giftName: '牛哇牛哇（新名称）',
    giftId: '31036',
    quantity: 10
  }, 300);
  const final = rememberLearnedGift(second, {
    giftName: '辣条',
    giftId: 1,
    quantity: 2
  }, 400);

  assert.deepEqual(final, [
    {
      giftName: '辣条',
      giftId: '1',
      lastSeenAt: 400,
      lastQuantity: 2
    },
    {
      giftName: '牛哇牛哇（新名称）',
      giftId: '31036',
      lastSeenAt: 300,
      lastQuantity: 10
    }
  ]);
});

test('gift quantity adds the real unit count and is safely bounded', () => {
  assert.equal(normalizeGiftQuantity(10), 10);
  assert.equal(addGiftRequestCredits(2, 10), 12);
  assert.equal(normalizeGiftQuantity(0), 0);
  assert.equal(normalizeGiftQuantity('invalid'), 0);
  assert.equal(normalizeGiftQuantity(50_000), 10_000);
});

test('parses SEND_GIFT unit count without using cumulative combo fields', () => {
  assert.deepEqual(parseBilibiliGiftCreditEvent({
    cmd: 'SEND_GIFT',
    data: {
      uid: 123456,
      uname: '测试用户',
      giftName: '牛哇牛哇',
      giftId: 31036,
      num: 10,
      combo_num: 99,
      guard_level: 3,
      rnd: 'gift-event-1'
    }
  }), {
    uid: '123456',
    userName: '测试用户',
    giftName: '牛哇牛哇',
    giftId: '31036',
    guardLevel: 3,
    quantity: 10,
    eventId: 'gift-event-1'
  });
  assert.equal(parseBilibiliGiftCreditEvent({
    cmd: 'COMBO_SEND',
    data: { uid: 1, giftName: '牛哇牛哇', num: 99 }
  }), null);
});

test('only a successful accepted request consumes one session credit', () => {
  const requirement = { giftName: '辣条', giftId: '' };
  assert.equal(canRequestWithGiftCredits(requirement, 0, false), false);
  assert.equal(canRequestWithGiftCredits(requirement, 1, false), true);
  assert.equal(consumeGiftRequestCredit(requirement, 3, false, false), 3);
  assert.equal(consumeGiftRequestCredit(requirement, 3, false, true), 2);
  assert.equal(consumeGiftRequestCredit(requirement, 3, true, true), 3);
});
