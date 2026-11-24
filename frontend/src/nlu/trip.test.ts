import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from './parser.ts';

const q = (text: string) => parseCommand(text, {}).intents;

test('trip questions name the topic and, when said, the place', () => {
  assert.deepEqual(q('Juhu Beach tak kitna time lagega'), [{ type: 'query', topic: 'eta', destination: 'Juhu Beach' }]);
  assert.deepEqual(q('how long will it take to reach Pune'), [{ type: 'query', topic: 'eta', destination: 'Pune' }]);
  assert.deepEqual(q('how far is it'), [{ type: 'query', topic: 'distance' }]);
  assert.deepEqual(q('toll kitna hai'), [{ type: 'query', topic: 'toll' }]);
  assert.deepEqual(q('petrol kitne ka lagega'), [{ type: 'query', topic: 'fuel_cost' }]);
});

test('several trip questions in one sentence', () => {
  assert.deepEqual(q('kitni door hai aur toll kitna lagega').map((i) => i.type === 'query' && i.topic), ['distance', 'toll']);
});

test('existing questions and navigation still parse as before', () => {
  assert.deepEqual(q('petrol kitna hai'), [{ type: 'query', topic: 'fuel' }]);
  assert.equal(q('Juhu Beach le chalo')[0]?.type, 'nav.start');
});
