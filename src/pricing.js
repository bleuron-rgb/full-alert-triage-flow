const TAX_RATE = 0.13;
const LOYALTY_DISCOUNTS = { gold: 0.1, silver: 0.05, bronze: 0.02 };

function roundCents(amount) {
  return Math.round(amount * 100) / 100;
}

export function subtotal(items) {
  return items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
}

export function loyaltyDiscount(customer) {
  return LOYALTY_DISCOUNTS[customer.loyalty?.tier] ?? 0;
}

export function orderTotal(order, customer) {
  const discounted = subtotal(order.items) * (1 - loyaltyDiscount(customer));
  return roundCents(discounted * (1 + TAX_RATE));
}
