// In-memory fixtures standing in for the customer and order databases.

// Customers who never enrolled in the loyalty program have no `loyalty` field.
const customers = new Map([
  ['c_100', { id: 'c_100', name: 'Avery Chen', loyalty: { tier: 'gold', since: '2021-03-14' } }],
  ['c_101', { id: 'c_101', name: 'Jordan Patel', loyalty: { tier: 'silver', since: '2023-07-02' } }],
  ['c_102', { id: 'c_102', name: 'Sam Rivera' }],
  ['c_103', { id: 'c_103', name: 'Morgan Blake', loyalty: { tier: 'bronze', since: '2025-11-20' } }],
  ['c_104', { id: 'c_104', name: 'Riley Okafor' }],
]);

const orders = new Map([
  ['o_1001', { id: 'o_1001', customerId: 'c_100', items: [
    { sku: 'KB-01', unitPrice: 89.99, quantity: 1 },
    { sku: 'MS-02', unitPrice: 24.5, quantity: 2 },
  ] }],
  ['o_1002', { id: 'o_1002', customerId: 'c_101', items: [
    { sku: 'HD-10', unitPrice: 149.0, quantity: 1 },
  ] }],
  ['o_1003', { id: 'o_1003', customerId: 'c_102', items: [
    { sku: 'CB-03', unitPrice: 12.0, quantity: 3 },
  ] }],
  ['o_1004', { id: 'o_1004', customerId: 'c_103', items: [
    { sku: 'MN-27', unitPrice: 319.0, quantity: 1 },
    { sku: 'CB-03', unitPrice: 12.0, quantity: 1 },
  ] }],
  ['o_1005', { id: 'o_1005', customerId: 'c_104', items: [
    { sku: 'MS-02', unitPrice: 24.5, quantity: 1 },
  ] }],
  ['o_1006', { id: 'o_1006', customerId: 'c_100', items: [
    { sku: 'DK-05', unitPrice: 499.0, quantity: 1 },
  ] }],
]);

export function findOrder(id) {
  return orders.get(id);
}

export function findCustomer(id) {
  return customers.get(id);
}

export function listOrderIds() {
  return [...orders.keys()];
}
