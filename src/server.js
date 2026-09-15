import http from 'node:http';
import { createHandler } from './app.js';

const PORT = Number(process.env.PORT ?? 3000);

http.createServer(createHandler()).listen(PORT, () => {
  console.log(`orders-api listening on http://localhost:${PORT}`);
});
