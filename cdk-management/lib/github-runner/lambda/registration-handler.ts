import { EC2Client, DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import {
  SSMClient,
  SendCommandCommand,
  DescribeInstanceInformationCommand,
} from '@aws-sdk/client-ssm';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { request } from 'node:https';
import type { IncomingMessage } from 'node:http';

const ec2 = new EC2Client({});
const ssm = new SSMClient({});
const sm = new SecretsManagerClient({});

const GITHUB_ORG = process.env.GITHUB_ORG!;
const SECRET_NAME = process.env.GITHUB_TOKEN_SECRET_NAME!;

async function getGithubPat(): Promise<string> {
  const { SecretString } = await sm.send(new GetSecretValueCommand({ SecretId: SECRET_NAME }));
  if (!SecretString) throw new Error('Secret has no string value');
  return SecretString;
}

async function hasRunnerTag(instanceId: string): Promise<boolean> {
  const { Reservations } = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
  const tags = Reservations?.[0]?.Instances?.[0]?.Tags ?? [];
  return tags.some(t => t.Key === 'github-runner' && t.Value === 'true');
}

function githubPost(path: string, pat: string): Promise<{ token: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: 'api.github.com',
        path,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${pat}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'aws-github-runner',
          'Content-Length': '0',
        },
      },
      (res: IncomingMessage) => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(JSON.parse(body));
          } else {
            reject(new Error(`GitHub API ${res.statusCode}: ${body}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function getRegistrationToken(pat: string): Promise<string> {
  const result = await githubPost(
    `/orgs/${GITHUB_ORG}/actions/runners/registration-token`,
    pat
  );
  return result.token;
}

async function waitForSsmOnline(instanceId: string): Promise<void> {
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const { InstanceInformationList } = await ssm.send(
      new DescribeInstanceInformationCommand({
        Filters: [{ Key: 'InstanceIds', Values: [instanceId] }],
      })
    );
    if (InstanceInformationList?.[0]?.PingStatus === 'Online') return;
    await new Promise<void>(r => setTimeout(r, 15_000));
  }
  throw new Error(`Instance ${instanceId} did not register with SSM within 5 minutes`);
}

export async function handler(event: { detail: { 'instance-id': string } }): Promise<void> {
  const instanceId = event.detail['instance-id'];

  if (!await hasRunnerTag(instanceId)) return;

  const pat = await getGithubPat();
  const token = await getRegistrationToken(pat);

  await waitForSsmOnline(instanceId);

  const region = process.env.AWS_REGION ?? 'us-east-1';
  const commands = [
    'cd /opt/actions-runner',
    `sudo -u github-runner ./config.sh --url https://github.com/${GITHUB_ORG} --token ${token} --name ${instanceId} --ephemeral --unattended --labels self-hosted,linux`,
    `sudo -u github-runner bash -c './run.sh; aws ec2 terminate-instances --instance-ids ${instanceId} --region ${region}'`,
  ];

  await ssm.send(new SendCommandCommand({
    InstanceIds: [instanceId],
    DocumentName: 'AWS-RunShellScript',
    Parameters: { commands },
    TimeoutSeconds: 7200,
    Comment: `Register and start ephemeral runner on ${instanceId}`,
  }));

  console.log(`SSM Run Command sent to ${instanceId} — runner will self-terminate after the job`);
}
