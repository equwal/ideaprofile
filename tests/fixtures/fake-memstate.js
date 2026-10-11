// A stand-in for the memstated daemon: the three read routes that the Memory tab uses. It records
// every request, so that a test can check that the dashboard never writes to memstate.

import http from 'node:http';

export const MEMORIES = [
  { id: 7, project_id: 'ideamine', keypath: 'task.summary.2026_09_21', content: 'Built the dashboard.', category: 'status', version: 2, created_at: 1790000000 },
  { id: 3, project_id: 'ideamine', keypath: 'decisions.sync', content: 'The server holds the archive.', category: 'decision', version: 1, created_at: 1789990000 },
];

export async function startFakeMemstate() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      requests.push(`${req.method} ${req.url}`);
      const json = (status, data) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
      const input = body ? JSON.parse(body) : {};
      if (req.method === 'GET' && req.url === '/api/v1/projects') {
        return json(200, { projects: [{ id: 'ideamine', created_at: 1789900000, memory_count: 2, last_updated_at: 1790000000 }] });
      }
      if (req.method === 'POST' && req.url === '/api/v1/keypaths') {
        const list = MEMORIES.filter((m) => m.project_id === input.project_id).map((m) => ({ ...m, content: input.include_content ? m.content : '' }));
        return json(200, { memories: list, total_count: list.length });
      }
      if (req.method === 'POST' && req.url === '/api/v1/memories/history') {
        const versions = [
          { ...MEMORIES[0], version: 1, content: 'Started the dashboard.', created_at: 1789950000 },
          MEMORIES[0],
        ].filter((m) => m.keypath === input.keypath);
        return json(200, { versions, total_versions: versions.length });
      }
      json(404, { error: 'not found' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}
