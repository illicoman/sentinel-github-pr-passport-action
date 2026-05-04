# Sentinel Change Passport GitHub Action

Advisory GitHub Action for Sentinel pilot PRs.

It answers one narrow question:

> Does this PR touch a protected pilot surface, and if yes, which evidence, reviewer, risk and next action should be visible?

It is not a general AI reviewer. It does not read file contents and does not block by default.

## What It Does

- Runs on `pull_request`.
- Reads the PR file list through the GitHub API.
- Sends only `path` and `status` to ADP.
- Calls `POST /admin/change-passports/preview`.
- Publishes or updates one PR comment marked with `<!-- sentinel-change-passport -->`.
- Writes a GitHub step summary.
- Writes `sentinel-change-passport/passport.json` for artifact upload.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `adp_base_url` | yes | | ADP pilot registry base URL. |
| `adp_token` | yes | | Bearer token for the ADP preview route. Masked by the action. |
| `launch_record_id` | yes | | ADP pilot launch record ID. |
| `agent_host` | no | `unknown` | Agent host label, for example `codex`, `claude`, `copilot`. |
| `requested_task` | no | | Optional task description used for advisory scope drift. |
| `fail_on` | no | `never` | `never`, `blocked`, `missing_evidence`, or `protected_surface`. |

Recommended pilot mode: `fail_on: never`.

## Outputs

| Output | Description |
| --- | --- |
| `decision` | Change Passport decision. |
| `severity` | Change Passport severity. |
| `protected_surfaces_count` | Number of protected surfaces touched. |
| `passport_path` | Local path to generated passport JSON. |

## Example Workflow

```yaml
name: Sentinel Change Passport

on:
  pull_request:

permissions:
  contents: read
  pull-requests: read
  issues: write
  actions: read

jobs:
  sentinel-passport:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - id: sentinel
        uses: ./tools/github-pr-passport-action
        with:
          adp_base_url: ${{ vars.SENTINEL_ADP_BASE_URL }}
          adp_token: ${{ secrets.SENTINEL_ADP_TOKEN }}
          launch_record_id: ${{ vars.SENTINEL_LAUNCH_RECORD_ID }}
          agent_host: codex
          requested_task: ${{ github.event.pull_request.title }}
          fail_on: never

      - uses: actions/upload-artifact@v4
        with:
          name: sentinel-change-passport
          path: ${{ steps.sentinel.outputs.passport_path }}
```

## PR Comment

The action creates or updates a single comment:

```md
## Sentinel Change Passport

Decision: needs_review

This PR touches a protected surface:
- CI/CD production release (`.github/workflows/deploy.yml`)

Evidence:
- Surface profile: present
- Launch authority: missing

Required review:
- Release owner

Next action:
Request release owner validation before merge.

Boundary:
Advisory only. Sentinel did not block this PR.
```

## Security

- `adp_token` and `GITHUB_TOKEN` are masked in GitHub Actions.
- The action never reads file contents.
- The action never sends GitHub secrets to ADP.
- The action refuses non-PR events in this version.
- The default mode does not fail the job.
- No GitHub App, Marketplace listing, status check app or broad enforcement is introduced.

## Limits

- This is an advisory action, not a merge gate by default.
- It depends on an existing ADP launch record.
- It uses the ADP Change Passport preview route; ADP remains the decision source.
- It writes no files to the client repository. The JSON passport is a temporary workspace artifact.
