import {
  EC2Client,
  RunInstancesCommand,
  DescribeInstanceStatusCommand,
} from '@aws-sdk/client-ec2';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

const LATEST_AMI_PARAM = '/github-runner/latest-ami-id';

const ec2 = new EC2Client({});
const ssm = new SSMClient({});
const secretsManager = new SecretsManagerClient({});

const GH_ORG = process.env.GH_ORG!;
const SECRET_NAME = process.env.GH_TOKEN_SECRET_NAME!;
const INSTANCE_PROFILE_NAME = process.env.RUNNER_INSTANCE_PROFILE_NAME!;
const SUBNET_ID = process.env.RUNNER_SUBNET_ID;
const INSTANCE_TYPE = process.env.RUNNER_INSTANCE_TYPE ?? 't3.medium';

async function getLatestRunnerAmiId(): Promise<string> {
  const { Parameter } = await ssm.send(new GetParameterCommand({
    Name: LATEST_AMI_PARAM,
  }));
  const amiId = Parameter?.Value;
  if (!amiId) throw new Error('SSM parameter /github-runner/latest-ami-id not found — run the Image Builder pipeline first');
  return amiId;
}

// Builds the user data script that runs on the EC2 instance at first boot.
// GH_ORG and SECRET_NAME are substituted here (Lambda env vars).
// INSTANCE_ID and REGION are resolved on the instance from the metadata service.
function buildUserData(): string {
  return `#!/bin/bash
set -euxo pipefail

# IMDSv2: obtain a session token first, then use it for all metadata reads
IMDS_TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 300")
INSTANCE_ID=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" \
  http://169.254.169.254/latest/meta-data/instance-id)
REGION=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" \
  http://169.254.169.254/latest/meta-data/placement/region)

PAT=$(aws secretsmanager get-secret-value \
  --secret-id '${SECRET_NAME}' \
  --region "$REGION" \
  --query 'SecretString' \
  --output text \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(next(iter(d.values())))")

REG_TOKEN=$(curl -sf -X POST \
  -H "Authorization: Bearer $PAT" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "https://api.github.com/orgs/${GH_ORG}/actions/runners/registration-token" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

cd /opt/actions-runner
sudo -u github-runner ./config.sh \
  --url "https://github.com/${GH_ORG}" \
  --token "$REG_TOKEN" \
  --name "$INSTANCE_ID" \
  --ephemeral \
  --unattended \
  --labels "$INSTANCE_ID"

set +e
sudo -u github-runner ./run.sh
set -e

aws ec2 terminate-instances --instance-ids "$INSTANCE_ID" --region "$REGION"
`;
}

async function launchInstance(amiId: string): Promise<string> {
  const { Instances = [] } = await ec2.send(new RunInstancesCommand({
    ImageId: amiId,
    InstanceType: INSTANCE_TYPE as any,
    MinCount: 1,
    MaxCount: 1,
    IamInstanceProfile: { Name: INSTANCE_PROFILE_NAME },
    UserData: Buffer.from(buildUserData()).toString('base64'),
    ...(SUBNET_ID ? { SubnetId: SUBNET_ID } : {}),
    TagSpecifications: [{
      ResourceType: 'instance',
      Tags: [
        { Key: 'Name', Value: 'github-runner-ephemeral' },
        { Key: 'github-runner', Value: 'true' },
      ],
    }],
  }));
  const instanceId = Instances[0]?.InstanceId;
  if (!instanceId) throw new Error('RunInstances returned no instance ID');
  return instanceId;
}

async function waitForInstanceRunning(instanceId: string): Promise<void> {
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    const { InstanceStatuses = [] } = await ec2.send(new DescribeInstanceStatusCommand({
      InstanceIds: [instanceId],
      IncludeAllInstances: true,
    }));
    const state = InstanceStatuses[0]?.InstanceState?.Name;
    if (state === 'running') return;
    if (state === 'terminated' || state === 'shutting-down') {
      throw new Error(`Instance ${instanceId} terminated unexpectedly`);
    }
    await new Promise<void>(r => setTimeout(r, 10_000));
  }
  throw new Error(`Instance ${instanceId} did not reach running state within 10 minutes`);
}

async function getGitHubPat(): Promise<string> {
  const { SecretString } = await secretsManager.send(new GetSecretValueCommand({ SecretId: SECRET_NAME }));
  if (!SecretString) throw new Error('Secret has no string value');
  const parsed = JSON.parse(SecretString) as Record<string, string>;
  return Object.values(parsed)[0];
}

async function waitForRunnerOnline(instanceId: string): Promise<void> {
  const pat = await getGitHubPat();
  const deadline = Date.now() + 8 * 60 * 1000;
  while (Date.now() < deadline) {
    let page = 1;
    let found = false;
    while (!found) {
      const resp = await fetch(
        `https://api.github.com/orgs/${GH_ORG}/actions/runners?per_page=100&page=${page}`,
        {
          headers: {
            Authorization: `Bearer ${pat}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        },
      );
      if (!resp.ok) throw new Error(`GitHub API error: ${resp.status} ${await resp.text()}`);
      const data = await resp.json() as { total_count: number; runners: Array<{ name: string; status: string }> };
      const runner = data.runners.find(r => r.name === instanceId);
      if (runner?.status === 'online') {
        console.log(`Runner ${instanceId} is online`);
        return;
      }
      if (runner) {
        console.log(`Runner ${instanceId} found with status=${runner.status}, waiting...`);
        break;
      }
      if (data.runners.length < 100) break; // no more pages
      page++;
    }
    await new Promise<void>(r => setTimeout(r, 15_000));
  }
  throw new Error(`Runner ${instanceId} did not come online within 8 minutes`);
}

export async function handler(_event: unknown): Promise<{ instanceId: string; runnerName: string }> {
  const amiId = await getLatestRunnerAmiId();
  console.log(`Using AMI: ${amiId}`);

  const instanceId = await launchInstance(amiId);
  console.log(`Launched instance: ${instanceId}`);

  await waitForInstanceRunning(instanceId);
  console.log(`Instance running: ${instanceId}`);

  await waitForRunnerOnline(instanceId);

  return { instanceId, runnerName: instanceId };
}
