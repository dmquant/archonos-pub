import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createArchonEdgeRuntime } from '../src/index.mjs';
import { startLocalEdgeServer } from '../src/dev-server.mjs';

test('a hosted workbench joins an independent team and reuses the scoped session for messages', async (t) => {
  const remote = 'https://mesh-target.test';
  const operator = 'test-operator-passkey';
  const edge = createArchonEdgeRuntime({ ARCHON_ADMIN_TOKEN: operator });
  const createTeam = (name) => edge.fetch(new Request(remote + '/api/mesh/teams', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + operator, 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  })).then((res) => res.json());
  const { team } = await createTeam('Remote Team');
  await createTeam('Separate Team');
  const joinedHeaders = { 'x-archon-mesh-remote': remote, 'content-type': 'application/json' };

  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (url, options) => {
    if (new URL(url).origin !== remote) return originalFetch(url, options);
    assert.equal(options.redirect, 'error');
    assert.ok(!options.headers.authorization && !options.headers.cookie);
    return edge.fetch(new Request(url, options));
  });

  const previousOrigin = process.env.ARCHON_MESH_TEAM_SERVER_URL;
  process.env.ARCHON_MESH_TEAM_SERVER_URL = remote;
  const server = startLocalEdgeServer({ port: 0 });
  t.after(async () => {
    if (previousOrigin === undefined) delete process.env.ARCHON_MESH_TEAM_SERVER_URL;
    else process.env.ARCHON_MESH_TEAM_SERVER_URL = previousOrigin;
    await new Promise((resolve) => server.close(resolve));
  });
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const mesh = (path, headers, body) => originalFetch(base + '/api/mesh/' + path, {
    headers, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
  });
  const settings = await (await mesh('remote-server')).json();
  assert.equal(settings.origin, remote);
  assert.equal((await mesh('teams', joinedHeaders)).status, 401);
  assert.equal((await mesh('teams/join', { ...joinedHeaders, 'x-archon-mesh-remote': 'https://other.test' }, {})).status, 400);
  assert.equal((await mesh('teams/join', { ...joinedHeaders, 'sec-fetch-site': 'cross-site' }, {})).status, 403);
  assert.equal((await mesh('teams/join', joinedHeaders, { teamId: team.teamId, userId: 'peer' })).status, 403);
  const response = await mesh('teams/join', joinedHeaders, { inviteToken: team.inviteToken, userId: 'peer' });
  assert.equal(response.status, 200);
  const joined = await response.json();
  assert.equal(joined.team.teamId, team.teamId);
  assert.equal(joined.team.inviteToken, undefined);
  const headers = { ...joinedHeaders, 'x-archon-peer-session': joined.peerSessionToken };
  assert.equal((await mesh('teams', headers, { name: 'Unauthorized Team' })).status, 405);
  const message = await mesh('teams/messages', headers, { teamId: team.teamId, senderId: 'peer', content: 'Remote hello' });
  assert.equal(message.status, 201);
  const listed = await (await mesh('teams', headers)).json();
  assert.deepEqual(listed.teams.map((entry) => entry.teamId), [team.teamId]);
  assert.equal(listed.teams[0].accessKeys, undefined);
  assert.ok(listed.teams[0].messages.some((entry) => entry.content === 'Remote hello'));
  const local = await (await mesh('teams')).json();
  assert.ok(local.teams.every((entry) => entry.teamId !== team.teamId));
});
