import { findCustomer, findOrder } from './data.js';
import { orderTotal } from './pricing.js';

const ORDER_TOTAL_ROUTE = /^\/orders\/([\w-]+)\/total$/;

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function routeRequest(req, res) {
  if (req.method === 'GET' && req.url === '/healthz') return sendJson(res, 200, { status: 'ok' });

  const match = req.method === 'GET' && ORDER_TOTAL_ROUTE.exec(req.url);
  if (!match) return sendJson(res, 404, { error: 'not_found' });

  const order = findOrder(match[1]);
  if (!order) return sendJson(res, 404, { error: 'order_not_found' });

  const customer = findCustomer(order.customerId);
  sendJson(res, 200, { orderId: order.id, customerId: customer.id, total: orderTotal(order, customer) });
}

export function createHandler({ onError = (err) => console.error(err.stack) } = {}) {
  return (req, res) => {
    try {
      routeRequest(req, res);
    } catch (err) {
      onError(err, req);
      sendJson(res, 500, { error: 'internal_error' });
    }
  };
}
