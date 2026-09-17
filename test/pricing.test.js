import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loyaltyDiscount, orderTotal, subtotal } from '../src/pricing.js';

const gold = { id: 'c_1', loyalty: { tier: 'gold' } };
const silver = { id: 'c_2', loyalty: { tier: 'silver' } };
const unrankedTier = { id: 'c_3', loyalty: { tier: 'standard' } };

test('subtotal sums unit price times quantity', () => {
  const items = [
    { unitPrice: 10, quantity: 2 },
    { unitPrice: 2.5, quantity: 4 },
  ];
  assert.equal(subtotal(items), 30);
});

test('orderTotal adds 13% tax and rounds to cents', () => {
  const order = { items: [{ unitPrice: 19.99, quantity: 1 }] };
  assert.equal(orderTotal(order, unrankedTier), 22.59);
});

test('loyaltyDiscount maps tiers to discount rates', () => {
  assert.equal(loyaltyDiscount(gold), 0.1);
  assert.equal(loyaltyDiscount(silver), 0.05);
  assert.equal(loyaltyDiscount(unrankedTier), 0);
});

test('orderTotal applies the loyalty discount before tax', () => {
  const order = { items: [{ unitPrice: 100, quantity: 1 }] };
  assert.equal(orderTotal(order, gold), 101.7);
  assert.equal(orderTotal(order, silver), 107.35);
});

test('orderTotal does not error for a customer who never enrolled in the loyalty program', () => {
  const neverEnrolled = { id: 'c_102', name: 'Sam Rivera' };
  const order = { items: [{ unitPrice: 12.0, quantity: 3 }] };
  assert.equal(orderTotal(order, neverEnrolled), 40.68);
});
