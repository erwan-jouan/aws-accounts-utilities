# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo does

Bootstraps a two-account AWS setup (management/CICD + production) with:
- GitHub OIDC trust so Actions jobs authenticate without stored credentials
- CDK bootstrap of both accounts
- A self-deletion scheduler deployed to both accounts (DynamoDB TTL → Lambda → CloudFormation DeleteStack)
- A self-hosted GitHub runner infrastructure on the management account (EC2 Image Builder + registration Lambda)

## Sub-project layout

| Directory | Purpose |
|---|---|
| `github-oidc/` | CloudFormation template — one-time manual deploy via `make deploy-oidc` |
| `cdk-common/` | CDK app deployed to both accounts by the `Bootstrap AWS Accounts` workflow |
| `cdk-management/` | CDK app deployed to the management account by the `Github runner on management account` workflow |
| `list-resources/` | Standalone TypeScript CLI — scans all services/regions and prints a hierarchical ARN tree to stdout |

## Environment variables

Copy `example.env` to `.env` and fill in:

```
AWS_REGION=
PROD_ACCOUNT_ID=
CICD_ACCOUNT_ID=
GH_ACTIONS_ROLE_NAME=
AUTHORIZED_ACTOR=
```

`cdk-management` additionally requires `GH_ORG` and `GH_TOKEN_SECRET_NAME` at synth time (the bin entry point throws if missing).

## Commands

All local operations go through the Makefile, which sources `.env` automatically:

```bash
make deploy-oidc                  # deploy OIDC CloudFormation to both accounts (one-time)
make deploy-oidc-management       # management account only
make deploy-oidc-production       # production account only
make bootstrap                    # cdk bootstrap both accounts
make bootstrap-management
make bootstrap-production
```

Inside each CDK sub-project (`cdk-common/`, `cdk-management/`):

```bash
npm run build      # tsc compile
npm test           # jest
npx cdk synth
npx cdk deploy --require-approval never
```

Inside `list-resources/`:

```bash
npm run build      # tsc → dist/
node dist/index.js # requires active AWS credentials; writes JSON to stdout, progress to stderr
```

## Architecture notes

### cdk-common — auto-deletion scheduler

`CdkCommonStack` (`cdk-common/lib/cdk-common-stack.ts`) creates a reusable deletion mechanism:
- DynamoDB table with TTL enabled and a DynamoDB Stream
- **DeletionSchedulerFn** — a CloudFormation custom resource handler; `Create/Update` writes a TTL record, `Delete` removes it. Exported as `CdkCommonStack-DeletionSchedulerFnArn`.
- **DeletionExecutorFn** — triggered by the stream's `REMOVE` event (TTL expiry only, filtered by `userIdentity.type = Service`); calls `cloudformation:DeleteStack`.

Consumer stacks use the exported Lambda ARN as a `ServiceToken` in a custom resource to schedule their own deletion.

### cdk-management — GitHub self-hosted runner

`GithubRunnerStack` (`cdk-management/lib/github-runner/GithubRunnerStack.ts`) composes:
- EC2 Image Builder pipeline (component + recipe + infrastructure config + build instance profile) to bake a runner AMI
- `RunnerEc2InstanceProfile` — attach to any EC2 instance that should act as a runner, plus tag `github-runner=true`
- `RegistrationLambda` — EventBridge rule fires on every EC2 `running` state change; Lambda runs an SSM `AWS-RunShellScript` command on the instance to register it as a GitHub Actions runner using a token fetched from Secrets Manager

### github-oidc — OIDC trust policy

The trust condition uses a `StringLike` wildcard (`repo:${GitHubOrg}*/${GitHubRepo}*:*`) to handle GitHub's 2024 OIDC hardening that appends `@<org_id>` / `@<repo_id>` suffixes to `sub` claims. Pass `CreateOIDCProvider=false` if the provider already exists in an account (only one allowed per account).

### GitHub Actions workflows

Both workflows are `workflow_dispatch` only and check `github.actor` against the `AUTHORIZED_ACTOR` secret before proceeding. The bootstrap workflow runs `bootstrap-production` only after `bootstrap-management` succeeds (production must trust the management account ID).
