'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  COMMENT_MARKER,
  buildAdpPayload,
  buildCommentBody,
  collectPullRequestFiles,
  mapGithubFileStatus,
  parseEvent,
  publishPassportComment,
  runAction,
  shouldFail,
} = require('../src/action');

function headers(values) {
  const map = Object.assign({}, values || {});
  return {
    get(name) {
      return map[String(name).toLowerCase()] || null;
    },
  };
}

function jsonResponse(body, options = {}) {
  return {
    ok: options.ok !== false,
    status: options.status || 200,
    headers: headers(options.headers),
    async text() {
      return JSON.stringify(body);
    },
  };
}

function makeFetch(responses, calls) {
  return async function fetchMock(url, options) {
    calls.push({ url, options: options || {} });
    if (responses.length === 0) {
      throw new Error('Unexpected fetch call: ' + url);
    }
    const response = responses.shift();
    return typeof response === 'function' ? response(url, options || {}) : response;
  };
}

function eventPayload() {
  return JSON.stringify({
    number: 42,
    pull_request: {
      number: 42,
    },
    repository: {
      name: 'demo',
      owner: {
        login: 'acme',
      },
    },
  });
}

function baseEnv(tempRoot) {
  const eventPath = path.join(tempRoot, 'event.json');
  fs.writeFileSync(eventPath, eventPayload());
  return {
    GITHUB_API_URL: 'https://api.github.test',
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_TOKEN: 'github-token-secret',
    INPUT_ADP_BASE_URL: 'https://adp.example.test',
    INPUT_ADP_TOKEN: 'adp-token-secret',
    INPUT_LAUNCH_RECORD_ID: 'plr_123',
    INPUT_AGENT_HOST: 'codex',
    INPUT_REQUESTED_TASK: 'Update workflow deploy',
    INPUT_FAIL_ON: 'never',
  };
}

function passport(overrides) {
  return Object.assign({
    passportId: 'preview_1',
    decision: 'needs_review',
    severity: 'high',
    markdown: [
      '## Sentinel Change Passport',
      '',
      'Decision: needs_review',
      '',
      'Boundary:',
      'Preview only. Sentinel has not blocked this PR.',
    ].join('\n'),
    protectedSurfacesTouched: [
      {
        surfaceId: 'ci_cd_workflow_write',
      },
    ],
  }, overrides || {});
}

test('parseEvent refuse les evenements non pull_request', function parseEventTest() {
  assert.throws(function parse() {
    parseEvent({
      GITHUB_EVENT_NAME: 'push',
      GITHUB_EVENT_PATH: '/tmp/unused-event.json',
    }, function read() {
      return '{}';
    });
  }, /only runs on pull_request/);
});

test('collecte les fichiers PR avec pagination et normalise les statuts', async function collectFilesTest() {
  const calls = [];
  const fetchMock = makeFetch([
    jsonResponse([
      { filename: '.github/workflows/deploy.yml', status: 'modified' },
      { filename: 'old.yml', status: 'removed' },
    ], {
      headers: {
        link: '<https://api.github.test/page2>; rel="next"',
      },
    }),
    jsonResponse([
      { filename: 'renamed.yml', status: 'renamed' },
    ]),
  ], calls);

  const files = await collectPullRequestFiles({
    owner: 'acme',
    repo: 'demo',
    pullNumber: 42,
  }, {
    GITHUB_API_URL: 'https://api.github.test',
    GITHUB_TOKEN: 'github-token-secret',
  }, fetchMock);

  assert.deepEqual(files, [
    { path: '.github/workflows/deploy.yml', status: 'modified' },
    { path: 'old.yml', status: 'deleted' },
    { path: 'renamed.yml', status: 'renamed' },
  ]);
  assert.equal(calls.length, 2);
  assert.equal(mapGithubFileStatus('unknown-status'), 'unknown');
});

test('construit le payload ADP sans contenu de fichier', function payloadTest() {
  const payload = buildAdpPayload({
    launchRecordId: 'plr_123',
    agentHost: 'codex',
    requestedTask: 'Update workflow',
  }, [
    { path: '.github/workflows/deploy.yml', status: 'modified' },
  ]);

  assert.deepEqual(payload, {
    launchRecordId: 'plr_123',
    changedFiles: [
      { path: '.github/workflows/deploy.yml', status: 'modified' },
    ],
    agentHost: 'codex',
    requestedTask: 'Update workflow',
  });
  assert.equal(JSON.stringify(payload).includes('content'), false);
});

test('rend un commentaire Markdown stable avec marker anti-spam', function markdownTest() {
  const body = buildCommentBody(passport());

  assert.match(body, new RegExp(COMMENT_MARKER));
  assert.match(body, /## Sentinel Change Passport/);
  assert.match(body, /Advisory only\. Sentinel did not block this PR\./);
  assert.doesNotMatch(body, /\bsafe\b/i);
});

test('met a jour le commentaire Sentinel existant', async function updateCommentTest() {
  const calls = [];
  const fetchMock = makeFetch([
    jsonResponse([
      { id: 1001, body: COMMENT_MARKER + '\nold body' },
    ]),
    jsonResponse({ id: 1001 }),
  ], calls);

  const result = await publishPassportComment({
    owner: 'acme',
    repo: 'demo',
    pullNumber: 42,
  }, {
    GITHUB_API_URL: 'https://api.github.test',
    GITHUB_TOKEN: 'github-token-secret',
  }, fetchMock, passport());

  assert.equal(result.mode, 'updated');
  assert.equal(calls[1].options.method, 'PATCH');
  assert.match(calls[1].url, /issues\/comments\/1001/);
});

test('cree un commentaire Sentinel si aucun marker n existe', async function createCommentTest() {
  const calls = [];
  const fetchMock = makeFetch([
    jsonResponse([{ id: 1, body: 'regular comment' }]),
    jsonResponse({ id: 1002 }),
  ], calls);

  const result = await publishPassportComment({
    owner: 'acme',
    repo: 'demo',
    pullNumber: 42,
  }, {
    GITHUB_API_URL: 'https://api.github.test',
    GITHUB_TOKEN: 'github-token-secret',
  }, fetchMock, passport());

  assert.equal(result.mode, 'created');
  assert.equal(result.commentId, 1002);
  assert.equal(calls[1].options.method, 'POST');
  assert.match(calls[1].url, /issues\/42\/comments/);
});

test('fail_on never ne bloque pas et blocked bloque seulement blocked', function failOnTest() {
  assert.equal(shouldFail('never', passport({ decision: 'blocked' })), false);
  assert.equal(shouldFail('blocked', passport({ decision: 'missing_evidence' })), false);
  assert.equal(shouldFail('blocked', passport({ decision: 'blocked' })), true);
  assert.equal(shouldFail('protected_surface', passport({ protectedSurfacesTouched: [] })), false);
  assert.equal(shouldFail('protected_surface', passport()), true);
});

test('runAction masque les tokens hors logs applicatifs et produit les outputs', async function runActionTest() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-action-test-'));
  const env = Object.assign(baseEnv(tempRoot), {
    GITHUB_OUTPUT: path.join(tempRoot, 'outputs.txt'),
    GITHUB_STEP_SUMMARY: path.join(tempRoot, 'summary.md'),
  });
  const logs = [];
  const calls = [];
  const fetchMock = makeFetch([
    jsonResponse([{ filename: '.github/workflows/deploy.yml', status: 'modified' }]),
    jsonResponse({ changePassport: passport() }),
    jsonResponse([]),
    jsonResponse({ id: 1002 }),
  ], calls);

  const result = await runAction({
    cwd: tempRoot,
    env,
    fetch: fetchMock,
    logger: {
      log(value) {
        logs.push(String(value));
      },
      error(value) {
        logs.push(String(value));
      },
    },
  });

  assert.equal(result.passport.decision, 'needs_review');
  assert.equal(logs.join('\n').includes('adp-token-secret'), false);
  assert.equal(logs.join('\n').includes('github-token-secret'), false);
  assert.match(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8'), /decision=needs_review/);
  assert.match(fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8'), /Sentinel Change Passport/);
  assert.equal(fs.existsSync(result.passportPath), true);
  assert.equal(calls.some(function bodyContainsContent(call) {
    return call.options.body && String(call.options.body).includes('file content');
  }), false);
});
