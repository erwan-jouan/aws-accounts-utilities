import {
  EC2Client,
  CreateFleetCommand,
  DescribeInstanceStatusCommand,
  SpotAllocationStrategy,
  FleetType,
  DefaultTargetCapacityType,
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
const LAUNCH_TEMPLATE_ID = process.env.LAUNCH_TEMPLATE_ID!;
const INSTANCE_TYPES = (process.env.RUNNER_INSTANCE_TYPES ?? 't3.medium,t3a.medium,t2.medium').split(',');
const SUBNET_ID = process.env.RUNNER_SUBNET_ID;

async function getLatestRunnerAmiId(): Promise<string> {
  const { Parameter } = await ssm.send(new GetParameterCommand({
    Name: LATEST_AMI_PARAM,
  }));
  const amiId = Parameter?.Value;
  if (!amiId) throw new Error('SSM parameter /github-runner/latest-ami-id not found — run the Image Builder pipeline first');
  return amiId;
}

async function launchFleet(amiId: string): Promise<string> {
  const { Instances = [], Errors = [] } = await ec2.send(new CreateFleetCommand({
    Type: FleetType.INSTANT,
    TargetCapacitySpecification: {
      TotalTargetCapacity: 1,
      DefaultTargetCapacityType: DefaultTargetCapacityType.SPOT,
    },
    SpotOptions: {
      AllocationStrategy: SpotAllocationStrategy.CAPACITY_OPTIMIZED,
    },
    LaunchTemplateConfigs: [{
      LaunchTemplateSpecification: {
        LaunchTemplateId: LAUNCH_TEMPLATE_ID,
        Version: '$Latest',
      },
      Overrides: INSTANCE_TYPES.map(type => ({
        InstanceType: type as any,
        ImageId: amiId,
        ...(SUBNET_ID ? { SubnetId: SUBNET_ID } : {}),
      })),
    }],
  }));

  const instanceId = Instances[0]?.InstanceIds?.[0];
  if (!instanceId) {
    const errorMessages = Errors.map(e => `${e.ErrorCode}: ${e.ErrorMessage}`).join('; ');
    throw new Error(`CreateFleet returned no instance. Fleet errors: ${errorMessages || 'none'}`);
  }
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

  const instanceId = await launchFleet(amiId);
  console.log(`Launched spot instance via fleet: ${instanceId}`);

  await waitForInstanceRunning(instanceId);
  console.log(`Instance running: ${instanceId}`);

  await waitForRunnerOnline(instanceId);

  return { instanceId, runnerName: instanceId };
}
