# cdk-management

CDK application for the management (CICD) account. Currently deploys the **GitHub self-hosted runner** stack: an EC2 Image Builder pipeline that bakes a runner AMI and a Lambda that automatically registers ephemeral org-level runners when tagged instances start.

---

## GitHub Runner — setup guide

### How it works

```
EC2 Image Builder pipeline
  └─ AL2023 + Node.js 20 + GitHub Actions runner binary
       └─ Baked AMI stored in Image Builder

When you launch an EC2 instance from that AMI with tag github-runner=true:
  EventBridge (EC2 running) → Lambda
    └─ Fetches PAT from Secrets Manager
    └─ Calls GitHub API → gets a one-time registration token
    └─ Waits for SSM agent to come online on the instance
    └─ Sends SSM Run Command: config.sh + run.sh --ephemeral
    └─ Runner picks up one job, then terminates the instance
```

Runner instances are **ephemeral**: they pick up exactly one job, then self-terminate. No state leaks between jobs.

---

### Prerequisites

- AWS CDK bootstrapped on the management account (`make deploy-oidc` + `cdk_bootstrap.yml` workflow already done)
- GitHub organization admin access (to create a PAT and register runners)

---

### Step 1 — Create a GitHub Fine-grained Personal Access Token

1. Go to **GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens**
2. Click **Generate new token**
3. Set **Resource owner** to your organization
4. Under **Organization permissions**, grant:
   - **Self-hosted runners** → **Read and write**
5. Set an expiration (1 year recommended; you will need to rotate it)
6. Copy the token — you won't see it again

> **Classic PAT alternative:** if fine-grained tokens are not available for your org, create a classic PAT with the `admin:org` scope.

---

### Step 2 — Store the PAT in AWS Secrets Manager

Run this once from a terminal authenticated to the management account:

```bash
aws secretsmanager create-secret \
  --name github-runner/pat \
  --description "GitHub PAT for self-hosted runner registration" \
  --secret-string "github_pat_xxxx..." \
  --region <your-region>
```

To rotate the secret later:

```bash
aws secretsmanager put-secret-value \
  --secret-id github-runner/pat \
  --secret-string "github_pat_new_value..."
```

---

### Step 3 — Configure GitHub repository secrets

In this repository go to **Settings → Secrets and variables → Actions** and add:

| Secret name | Value |
|---|---|
| `GITHUB_ORG` | Your GitHub organization name (e.g. `my-org`) |
| `GITHUB_TOKEN_SECRET_NAME` | The Secrets Manager secret name from step 2 (e.g. `github-runner/pat`) |

The following secrets must already exist from the initial bootstrap:

| Secret name | Description |
|---|---|
| `CICD_ACCOUNT_ID` | AWS management account ID |
| `AWS_REGION` | Deployment region |
| `GH_ACTIONS_ROLE_NAME` | IAM role name assumed by GitHub Actions |
| `AUTHORIZED_ACTOR` | GitHub username allowed to trigger the workflow |

---

### Step 4 — Deploy the stack

Trigger the **"Github runner on management account"** workflow from the Actions tab (`workflow_dispatch`). It will:
1. Bootstrap CDK on the management account
2. Deploy `GithubRunnerStack` (Image Builder pipeline + registration Lambda + IAM profiles)

To deploy locally instead:

```bash
cd cdk-management
npm ci
GITHUB_ORG=my-org \
GITHUB_TOKEN_SECRET_NAME=github-runner/pat \
npx cdk deploy GithubRunnerStack
```

---

### Step 5 — Bake the runner AMI (first time)

The Image Builder pipeline runs automatically every Sunday. To trigger it immediately after the first deploy:

```bash
aws imagebuilder start-image-pipeline-execution \
  --image-pipeline-arn $(aws imagebuilder list-image-pipelines \
    --query "imagePipelineList[?name=='github-runner-pipeline'].arn" \
    --output text) \
  --region <your-region>
```

The build takes roughly 15–20 minutes. Check progress in the **EC2 Image Builder** console.

---

### Step 6 — Launch a runner

Once the pipeline has produced an AMI, launch an EC2 instance with:

- **AMI**: the latest AMI produced by the `github-runner-pipeline` pipeline
- **Instance profile**: the value of the `GithubRunnerStack-RunnerInstanceProfileName` CloudFormation output
- **Tag**: `github-runner` = `true` (this triggers the registration Lambda)
- **Instance type**: `t3.medium` or larger

The Lambda will detect the new instance within seconds, register it with your GitHub organization, and start it. The runner will appear in **Organization → Settings → Actions → Runners** and pick up queued jobs automatically. After completing one job the instance terminates itself.

---

### Useful commands

```bash
npm run build    # compile TypeScript
npm run test     # run jest tests
npx cdk diff     # compare with deployed stack
npx cdk synth    # emit CloudFormation template (requires env vars)
```
