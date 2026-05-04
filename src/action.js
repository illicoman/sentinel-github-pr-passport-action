'use strict';

const fs = require('node:fs');
const path = require('node:path');

const COMMENT_MARKER = '<!-- sentinel-change-passport -->';
const DEFAULT_TIMEOUT_MS = 10000;
const VALID_FAIL_ON = Object.freeze(['never', 'blocked', 'missing_evidence', 'protected_surface']);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function cleanString(value, fallback) {
  return isNonEmptyString(value) ? value.trim() : fallback;
}

function getInput(env, name, options = {}) {
  const key = 'INPUT_' + name.toUpperCase().replace(/ /g, '_');
  const value = cleanString(env[key], '');
  if (options.required && value === '') {
    throw new Error('Input ' + name + ' is required');
  }
  return value || options.defaultValue || '';
}

function normalizeBaseUrl(value) {
  const baseUrl = cleanString(value, '');
  if (!baseUrl) {
    throw new Error('adp_base_url is required');
  }
  return baseUrl.replace(/\/+$/, '');
}

function normalizeFailOn(value) {
  const normalized = cleanString(value, 'never').toLowerCase();
  if (!VALID_FAIL_ON.includes(normalized)) {
    throw new Error('fail_on must be one of: ' + VALID_FAIL_ON.join(', '));
  }
  return normalized;
}

function readInputs(env) {
  return {
    adpBaseUrl: normalizeBaseUrl(getInput(env, 'adp_base_url', { required: true })),
    adpToken: getInput(env, 'adp_token', { required: true }),
    launchRecordId: getInput(env, 'launch_record_id', { required: true }),
    agentHost: getInput(env, 'agent_host', { defaultValue: 'unknown' }) || 'unknown',
    requestedTask: getInput(env, 'requested_task'),
    failOn: normalizeFailOn(getInput(env, 'fail_on', { defaultValue: 'never' })),
  };
}

function workflowCommandEscape(value) {
  return String(value)
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
}

function maskSecret(secret, logger) {
  if (!isNonEmptyString(secret)) {
    return;
  }
  logger.log('::add-mask::' + workflowCommandEscape(secret));
}

function parseEvent(env, readFile = fs.readFileSync) {
  const eventName = cleanString(env.GITHUB_EVENT_NAME, '');
  if (eventName !== 'pull_request' && eventName !== 'pull_request_target') {
    throw new Error('Sentinel Change Passport only runs on pull_request events in this version.');
  }
  const eventPath = cleanString(env.GITHUB_EVENT_PATH, '');
  if (!eventPath) {
    throw new Error('GITHUB_EVENT_PATH is required');
  }
  const payload = JSON.parse(readFile(eventPath, 'utf8'));
  const pullRequest = payload.pull_request || {};
  const repo = payload.repository || {};
  const owner = repo.owner && repo.owner.login ? repo.owner.login : null;
  const name = repo.name || null;
  const number = pullRequest.number || payload.number;
  if (!owner || !name || !number) {
    throw new Error('Pull request owner, repo and number are required in the GitHub event payload');
  }
  return {
    owner,
    repo: name,
    pullNumber: number,
  };
}

function mapGithubFileStatus(status) {
  if (status === 'removed') {
    return 'deleted';
  }
  if (status === 'modified' || status === 'added' || status === 'renamed') {
    return status;
  }
  return 'unknown';
}

function githubApiUrl(env, route) {
  const apiUrl = cleanString(env.GITHUB_API_URL, 'https://api.github.com').replace(/\/+$/, '');
  return apiUrl + route;
}

function parseNextLink(linkHeader) {
  if (!linkHeader) {
    return null;
  }
  const next = String(linkHeader).split(',').map(function part(value) {
    return value.trim();
  }).find(function isNext(value) {
    return /rel="next"/.test(value);
  });
  if (!next) {
    return null;
  }
  const match = next.match(/<([^>]+)>/);
  return match ? match[1] : null;
}

async function requestJson(fetchImpl, url, options = {}) {
  const response = await fetchImpl(url, options);
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = body && body.message ? body.message : ('HTTP ' + response.status);
    throw new Error(message);
  }
  return {
    body,
    headers: response.headers,
  };
}

function authHeaders(token) {
  return {
    accept: 'application/vnd.github+json',
    authorization: 'Bearer ' + token,
    'x-github-api-version': '2022-11-28',
  };
}

async function collectPullRequestFiles(context, env, fetchImpl) {
  const githubToken = cleanString(env.GITHUB_TOKEN, '');
  if (!githubToken) {
    throw new Error('GITHUB_TOKEN is required to read pull request files');
  }
  let url = githubApiUrl(
    env,
    '/repos/' + encodeURIComponent(context.owner) +
      '/' + encodeURIComponent(context.repo) +
      '/pulls/' + encodeURIComponent(String(context.pullNumber)) +
      '/files?per_page=100'
  );
  const files = [];
  while (url) {
    const result = await requestJson(fetchImpl, url, {
      method: 'GET',
      headers: authHeaders(githubToken),
    });
    const rows = Array.isArray(result.body) ? result.body : [];
    rows.forEach(function addFile(file) {
      files.push({
        path: file.filename,
        status: mapGithubFileStatus(file.status),
      });
    });
    url = parseNextLink(result.headers.get('link'));
  }
  return files;
}

function buildAdpPayload(inputs, changedFiles) {
  return {
    launchRecordId: inputs.launchRecordId,
    changedFiles,
    agentHost: inputs.agentHost,
    requestedTask: inputs.requestedTask || null,
  };
}

async function fetchChangePassport(inputs, changedFiles, fetchImpl) {
  const url = inputs.adpBaseUrl + '/admin/change-passports/preview';
  const result = await requestJson(fetchImpl, url, {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + inputs.adpToken,
      'content-type': 'application/json',
      'x-admin-role': 'viewer',
    },
    body: JSON.stringify(buildAdpPayload(inputs, changedFiles)),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!result.body || !result.body.changePassport) {
    throw new Error('ADP response did not include changePassport');
  }
  return result.body.changePassport;
}

function buildCommentBody(passport) {
  const markdown = cleanString(passport.markdown, '## Sentinel Change Passport\n\nNo passport markdown was returned.');
  return COMMENT_MARKER + '\n' + markdown.replace(
    'Preview only. Sentinel has not blocked this PR.',
    'Advisory only. Sentinel did not block this PR.'
  );
}

async function listIssueComments(context, env, fetchImpl) {
  const githubToken = cleanString(env.GITHUB_TOKEN, '');
  if (!githubToken) {
    throw new Error('GITHUB_TOKEN is required to publish the Sentinel PR comment');
  }
  let url = githubApiUrl(
    env,
    '/repos/' + encodeURIComponent(context.owner) +
      '/' + encodeURIComponent(context.repo) +
      '/issues/' + encodeURIComponent(String(context.pullNumber)) +
      '/comments?per_page=100'
  );
  const comments = [];
  while (url) {
    const result = await requestJson(fetchImpl, url, {
      method: 'GET',
      headers: authHeaders(githubToken),
    });
    comments.push.apply(comments, Array.isArray(result.body) ? result.body : []);
    url = parseNextLink(result.headers.get('link'));
  }
  return comments;
}

async function publishPassportComment(context, env, fetchImpl, passport) {
  const githubToken = cleanString(env.GITHUB_TOKEN, '');
  const body = buildCommentBody(passport);
  const comments = await listIssueComments(context, env, fetchImpl);
  const existing = comments.find(function hasMarker(comment) {
    return comment && typeof comment.body === 'string' && comment.body.includes(COMMENT_MARKER);
  });
  if (existing) {
    await requestJson(fetchImpl, githubApiUrl(env, '/repos/' + encodeURIComponent(context.owner) + '/' + encodeURIComponent(context.repo) + '/issues/comments/' + encodeURIComponent(String(existing.id))), {
      method: 'PATCH',
      headers: Object.assign({}, authHeaders(githubToken), {
        'content-type': 'application/json',
      }),
      body: JSON.stringify({ body }),
    });
    return {
      mode: 'updated',
      commentId: existing.id,
    };
  }
  const result = await requestJson(fetchImpl, githubApiUrl(env, '/repos/' + encodeURIComponent(context.owner) + '/' + encodeURIComponent(context.repo) + '/issues/' + encodeURIComponent(String(context.pullNumber)) + '/comments'), {
    method: 'POST',
    headers: Object.assign({}, authHeaders(githubToken), {
      'content-type': 'application/json',
    }),
    body: JSON.stringify({ body }),
  });
  return {
    mode: 'created',
    commentId: result.body && result.body.id ? result.body.id : null,
  };
}

function appendFile(filePath, content, appendFileSync = fs.appendFileSync) {
  if (!filePath) {
    return;
  }
  appendFileSync(filePath, content);
}

function writeOutput(env, name, value, appendFileSync = fs.appendFileSync) {
  if (!env.GITHUB_OUTPUT) {
    return;
  }
  appendFile(env.GITHUB_OUTPUT, name + '=' + String(value) + '\n', appendFileSync);
}

function writeStepSummary(env, passport, appendFileSync = fs.appendFileSync) {
  if (!env.GITHUB_STEP_SUMMARY) {
    return;
  }
  appendFile(env.GITHUB_STEP_SUMMARY, buildCommentBody(passport).replace(COMMENT_MARKER + '\n', '') + '\n', appendFileSync);
}

function writePassport(passport, cwd, writeFileSync = fs.writeFileSync) {
  const outDir = path.join(cwd || process.cwd(), 'sentinel-change-passport');
  fs.mkdirSync(outDir, { recursive: true });
  const passportPath = path.join(outDir, 'passport.json');
  writeFileSync(passportPath, JSON.stringify(passport, null, 2) + '\n');
  return passportPath;
}

function shouldFail(failOn, passport) {
  if (failOn === 'never') {
    return false;
  }
  if (failOn === 'blocked') {
    return passport.decision === 'blocked';
  }
  if (failOn === 'missing_evidence') {
    return passport.decision === 'missing_evidence' || passport.decision === 'blocked';
  }
  if (failOn === 'protected_surface') {
    return Array.isArray(passport.protectedSurfacesTouched) && passport.protectedSurfacesTouched.length > 0;
  }
  return false;
}

async function runAction(dependencies = {}) {
  const env = dependencies.env || process.env;
  const logger = dependencies.logger || console;
  const fetchImpl = dependencies.fetch || global.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is required');
  }
  const inputs = readInputs(env);
  if (env.GITHUB_ACTIONS === 'true') {
    maskSecret(inputs.adpToken, logger);
  }
  if (env.GITHUB_ACTIONS === 'true' && env.GITHUB_TOKEN) {
    maskSecret(env.GITHUB_TOKEN, logger);
  }
  const context = parseEvent(env, dependencies.readFileSync || fs.readFileSync);
  const changedFiles = await collectPullRequestFiles(context, env, fetchImpl);
  const passport = await fetchChangePassport(inputs, changedFiles, fetchImpl);
  const passportPath = writePassport(passport, dependencies.cwd || process.cwd(), dependencies.writeFileSync || fs.writeFileSync);
  await publishPassportComment(context, env, fetchImpl, passport);
  writeStepSummary(env, passport, dependencies.appendFileSync || fs.appendFileSync);
  writeOutput(env, 'decision', passport.decision || 'unknown', dependencies.appendFileSync || fs.appendFileSync);
  writeOutput(env, 'severity', passport.severity || 'info', dependencies.appendFileSync || fs.appendFileSync);
  writeOutput(env, 'protected_surfaces_count', Array.isArray(passport.protectedSurfacesTouched) ? passport.protectedSurfacesTouched.length : 0, dependencies.appendFileSync || fs.appendFileSync);
  writeOutput(env, 'passport_path', passportPath, dependencies.appendFileSync || fs.appendFileSync);
  if (shouldFail(inputs.failOn, passport)) {
    throw new Error('Sentinel Change Passport fail_on=' + inputs.failOn + ' matched decision=' + passport.decision);
  }
  return {
    changedFiles,
    inputs,
    passport,
    passportPath,
  };
}

module.exports = {
  COMMENT_MARKER,
  buildAdpPayload,
  buildCommentBody,
  collectPullRequestFiles,
  fetchChangePassport,
  mapGithubFileStatus,
  normalizeFailOn,
  parseEvent,
  publishPassportComment,
  readInputs,
  runAction,
  shouldFail,
  writeOutput,
  writeStepSummary,
};
