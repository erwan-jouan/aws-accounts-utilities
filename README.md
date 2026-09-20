# aws-accounts-prerequisites

CDK bootstrap for a two-account AWS setup: a **management** account that is trusted to deploy stacks into a **production** account.

---

## Setup

### Step 1 — Deploy the GitHub OIDC stack (manual, once)

Before running the GitHub Actions workflow you must create the OIDC identity provider and `GitHubActionsRole` in both accounts. This is a one-time operation done locally with your AWS CLI profiles.

```bash
make deploy-oidc
```

This deploys `cf-github-oidc.yml` to both accounts in sequence. The stack creates:
- An AWS IAM OIDC provider for `token.actions.githubusercontent.com`
- A `GitHubActionsRole` with `AdministratorAccess` scoped to this repository

Override org/repo if needed (defaults are `erwanjouan` / `aws-accounts-prerequisites`):

```bash
make deploy-oidc GH_ORG=my-org GITHUB_REPO=my-repo
```

If the OIDC provider already exists in an account, add `CreateOIDCProvider=false`:

```bash
make deploy-oidc-management GH_ORG=my-org GITHUB_REPO=my-repo \
  # then edit cf-github-oidc.yml or pass CreateOIDCProvider=false via --parameter-overrides
```

### Step 2 — Add GitHub secrets

Go to **Settings → Secrets and variables → Actions** and add:

```
# AWS
AWS_REGION=XXX
AWS_PROD_ACCOUNT_ID=XXX
AWS_CICD_ACCOUNT_ID=XXX
AWS_ORGANIZATION_ID=XXX
AWS_ORGANIZATION_UNIT_ID=XXX
AWS_GITHUB_CONNECTION_ARN=XXX
AWS_EKS_CONSOLE_ROLE_ARN=XXX
# GitHub
GH_ACTIONS_ROLE_NAME=XXX
GH_AUTHORIZED_ACTOR=XXX
GH_ORG=XXX
GH_TOKEN_SECRET_NAME=XXX
```

### Step 3 — Bootstrap both accounts

Go to **Actions → Bootstrap AWS Accounts → Run workflow**.

The workflow authenticates to each account via OIDC (no stored credentials) and runs `cdk bootstrap`:

| Job | Depends on | What happens |
|---|---|---|
| `bootstrap-management` | — | `cdk bootstrap` on the management account |
| `bootstrap-production` | `bootstrap-management` | `cdk bootstrap --trust MANAGEMENT_ACCOUNT_ID` on the production account |

### Step 4 — Deploy the GitHub self-hosted runner (optional)

Go to **Actions → Github runner on management account → Run workflow**.

This deploys `github-runner-stack` from the `cdk/` project to the CICD account. It requires the following GitHub secrets in addition to those above:

| Secret | Description |
|---|---|
| `GH_ORG` | GitHub organisation that owns the runner |
| `GH_TOKEN_SECRET_NAME` | Name of the Secrets Manager secret holding the GitHub token used to register runners |

The stack provisions an EC2 Image Builder pipeline to bake a runner AMI, an EC2 instance profile for runner instances, and a registration Lambda that auto-registers new instances as GitHub Actions runners.

---

## Makefile targets

| Target | Description |
|---|---|
| `make deploy-oidc` | Deploy OIDC stack to both accounts |
| `make deploy-oidc-management` | Deploy OIDC stack to management account only |
| `make deploy-oidc-production` | Deploy OIDC stack to production account only |
| `make bootstrap` | CDK bootstrap both accounts locally |
| `make bootstrap-management` | CDK bootstrap management account only |
| `make bootstrap-production` | CDK bootstrap production account only |

Configure account IDs in `.env`:

```bash
cp .env.example .env
# edit .env
```

Override any variable on the command line:

```bash
make deploy-oidc GH_ORG=my-org GITHUB_REPO=my-repo
make bootstrap REGION=us-east-1 PROFILE_MANAGEMENT=mgmt PROFILE_PRODUCTION=prod
```
# aws-accounts-prerequisites
