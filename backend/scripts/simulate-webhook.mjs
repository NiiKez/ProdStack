// One-off: hit the /webhooks/github endpoint with a synthetic
// GitHub push payload, signed with the seeded project's webhook secret
// (`not-used-for-this-test`). Drives the M3 webhook -> enqueue path
// end-to-end against the target API (set API=<url>, defaults to localhost).
//
// Run: API=http://localhost:3000 node backend/scripts/simulate-webhook.mjs

import { createHmac, randomUUID } from 'node:crypto';

const API = process.env.API ?? 'http://localhost:3000';
const SECRET = 'not-used-for-this-test'; // matches seed-test-build.mjs
const REPO_ID = 0;
const BRANCH = 'master';
const SHA = 'b58e53791f17ebe0809895c0660356a87473fd85';

const payload = {
  ref: `refs/heads/${BRANCH}`,
  repository: { id: REPO_ID, full_name: 'GoogleCloudPlatform/cloud-run-hello' },
  head_commit: {
    id: SHA,
    message: 'simulated push for M3 end-to-end test',
    author: { name: 'builder-test-user' },
  },
};

const body = JSON.stringify(payload);
const signature = 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex');
const deliveryId = randomUUID();

console.log(`POST ${API}/api/webhooks/github`);
console.log(`  X-GitHub-Delivery: ${deliveryId}`);
console.log(`  X-Hub-Signature-256: ${signature.slice(0, 20)}…`);

const res = await fetch(`${API}/api/webhooks/github`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-github-event': 'push',
    'x-github-delivery': deliveryId,
    'x-hub-signature-256': signature,
  },
  body,
});

console.log(`HTTP ${res.status}`);
const text = await res.text();
console.log(text);
