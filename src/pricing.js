const TAX_RATE = 0.13;

function roundCents(amount) {
  return Math.round(amount * 100) / 100;
}

export function subtotal(items) {
  return items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
}

export function orderTotal(order) {
  const base = subtotal(order.items);
  return roundCents(base * (1 + TAX_RATE));
}
