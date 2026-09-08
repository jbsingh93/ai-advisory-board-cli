import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { test, expect } from '@playwright/test';

test('JSON parsing rejects malformed and oversized bodies without disrupting the API', async ({ request }) => {
  const malformed = await request.post('/api/actions', {
    headers: { 'content-type': 'application/json' },
    data: Buffer.from('{'),
  });
  expect(malformed.status()).toBe(400);

  const oversized = await request.post('/api/actions', {
    data: { title: 'x'.repeat(270_000) },
  });
  expect(oversized.status()).toBe(413);

  const invalid = await request.post('/api/actions', { data: { title: '   ' } });
  expect(invalid.status()).toBe(400);
  expect((await request.get('/api/state')).status()).toBe(200);
});

test('action JSON persists across reads and WebSocket events preserve its contents', async ({ request, baseURL }) => {
  const socket = new WebSocket(new URL('/ws', baseURL).href.replace(/^http/, 'ws'));
  let actionId: string | undefined;
  const title = `Dependency smoke ${randomUUID()} — æøå`;
  try {
    await once(socket, 'open');
    const [created, [message]] = await Promise.all([
      request.post('/api/actions', { data: { title, description: 'JSON and Unicode round trip' } }),
      once(socket, 'message'),
    ]);
    expect(created.status()).toBe(201);
    const action = await created.json();
    actionId = action.id;
    expect(action.title).toBe(title);
    expect(JSON.parse(message.toString())).toMatchObject({ type: 'action_created', action });

    const saved = await (await request.get('/api/actions')).json();
    expect(saved).toContainEqual(action);

    const [updated, [updateMessage]] = await Promise.all([
      request.patch(`/api/actions/${actionId}`, { data: { description: 'Updated through JSON API' } }),
      once(socket, 'message'),
    ]);
    expect(updated.status()).toBe(200);
    expect(JSON.parse(updateMessage.toString())).toMatchObject({
      type: 'action_updated', action: { id: actionId, description: 'Updated through JSON API' },
    });
    const reloaded = await (await request.get('/api/actions')).json();
    // Storage stamps its own updatedAt when it commits the record.
    expect(reloaded).toContainEqual(expect.objectContaining({
      id: actionId, title, description: 'Updated through JSON API',
      priority: action.priority, status: action.status,
    }));

    const [deleted, [deleteMessage]] = await Promise.all([
      request.delete(`/api/actions/${actionId}`),
      once(socket, 'message'),
    ]);
    expect(deleted.status()).toBe(204);
    expect(JSON.parse(deleteMessage.toString())).toEqual({ type: 'action_deleted', id: actionId });
    expect(await (await request.get('/api/actions')).json()).not.toContainEqual(expect.objectContaining({ id: actionId }));
    actionId = undefined;
  } finally {
    socket.terminate();
    if (actionId) await request.delete(`/api/actions/${actionId}`);
  }
});
