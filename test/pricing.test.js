import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderTotal, subtotal } from '../src/pricing.js';

test('subtotal sums unit price times quantity', () => {
  const items = [
    { unitPrice: 10, quantity: 2 },
    { unitPrice: 2.5, quantity: 4 },
  ];
  assert.equal(subtotal(items), 30);
});

test('orderTotal adds 13% tax and rounds to cents', () => {
  const order = { items: [{ unitPrice: 19.99, quantity: 1 }] };
  assert.equal(orderTotal(order), 22.59);
});
