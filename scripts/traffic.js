// Sends repeated requests for every known order so errors show up in monitoring.
// Usage: node scripts/traffic.js [rounds]   (BASE_URL defaults to http://localhost:3000)
import { listOrderIds } from '../src/data.js';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const rounds = Number(process.argv[2] ?? 10);
const counts = {};

for (let round = 0; round < rounds; round++) {
  for (const id of listOrderIds()) {
    const res = await fetch(`${BASE_URL}/orders/${id}/total`);
    counts[res.status] = (counts[res.status] ?? 0) + 1;
    await res.body?.cancel();
  }
}

console.log(`Sent ${rounds * listOrderIds().length} requests to ${BASE_URL}`);
for (const [status, count] of Object.entries(counts)) console.log(`  HTTP ${status}: ${count}`);
