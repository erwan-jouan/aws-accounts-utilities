import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import * as path from 'path';

const DEFAULT_INSTANCE_TYPES = ['t3.medium', 't3a.medium', 't2.medium'];

export interface RegistrationLambdaProps {
  githubOrg: string;
  githubTokenSecretName: string;
  runnerInstanceProfileName: string;
  runnerRoleArn: string;
  subnetId?: string;
  instanceTypes?: string[];
}

// Builds the user data script baked into the Launch Template.
// GH_ORG and secretName are CDK props resolved at synth time.
// INSTANCE_ID and REGION are resolved on the instance from the metadata service.
function buildUserData(githubOrg: string, secretName: string): string {
  return `#!/bin/bash
set -euxo pipefail

# IMDSv2: obtain a session token first, then use it for all metadata reads
IMDS_TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" \\
  -H "X-aws-ec2-metadata-token-ttl-seconds: 300")
INSTANCE_ID=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" \\
  http://169.254.169.254/latest/meta-data/instance-id)
REGION=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" \\
  http://169.254.169.254/latest/meta-data/placement/region)

PAT=$(aws secretsmanager get-secret-value \\
  --secret-id '${secretName}' \\
  --region "$REGION" \\
  --query 'SecretString' \\
  --output text \\
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(next(iter(d.values())))")

REG_TOKEN=$(curl -sf -X POST \\
  -H "Authorization: Bearer $PAT" \\
  -H "Accept: application/vnd.github+json" \\
  -H "X-GitHub-Api-Version: 2022-11-28" \\
  "https://api.github.com/orgs/${githubOrg}/actions/runners/registration-token" \\
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

cd /opt/actions-runner
sudo -u github-runner ./config.sh \\
  --url "https://github.com/${githubOrg}" \\
  --token "$REG_TOKEN" \\
  --name "$INSTANCE_ID" \\
  --ephemeral \\
  --unattended \\
  --labels "$INSTANCE_ID"

set +e
sudo -u github-runner ./run.sh
set -e

aws ec2 terminate-instances --instance-ids "$INSTANCE_ID" --region "$REGION"
`;
}

export class RegistrationLambda extends Construct {
  readonly functionArn: string;
  readonly functionName: string;

  constructor(scope: Construct, id: string, props: RegistrationLambdaProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);
    const instanceTypes = props.instanceTypes ?? DEFAULT_INSTANCE_TYPES;

    const launchTemplate = new ec2.CfnLaunchTemplate(this, 'RunnerLaunchTemplate', {
      launchTemplateData: {
        userData: cdk.Fn.base64(buildUserData(props.githubOrg, props.githubTokenSecretName)),
        iamInstanceProfile: { name: props.runnerInstanceProfileName },
        tagSpecifications: [{
          resourceType: 'instance',
          tags: [
            { key: 'Name', value: 'github-runner-ephemeral' },
            { key: 'github-runner', value: 'true' },
          ],
        }],
      },
    });

    const fn = new lambdaNodejs.NodejsFunction(this, 'Fn', {
      entry: path.join(__dirname, 'lambda', 'registration-handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      // Waits up to 10 min for EC2 running + 8 min for runner to register; 20 min gives headroom
      timeout: cdk.Duration.minutes(12),
      environment: {
        GH_ORG: props.githubOrg,
        GH_TOKEN_SECRET_NAME: props.githubTokenSecretName,
        LAUNCH_TEMPLATE_ID: launchTemplate.ref,
        RUNNER_INSTANCE_TYPES: instanceTypes.join(','),
        ...(props.subnetId ? { RUNNER_SUBNET_ID: props.subnetId } : {}),
      },
    });

    // Describe* actions do not support resource-level permissions
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ec2:DescribeInstanceStatus'],
      resources: ['*'],
    }));

    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${stack.region}:${stack.account}:parameter/github-runner/latest-ami-id`],
    }));

    // CreateFleet (Type: instant) delegates instance creation to RunInstances internally;
    // both actions must be allowed on the same set of underlying resources.
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ec2:RunInstances', 'ec2:CreateFleet'],
      resources: [
        `arn:aws:ec2:${stack.region}:${stack.account}:instance/*`,
        `arn:aws:ec2:${stack.region}:${stack.account}:image/*`,
        `arn:aws:ec2:${stack.region}:${stack.account}:network-interface/*`,
        `arn:aws:ec2:${stack.region}:${stack.account}:security-group/*`,
        `arn:aws:ec2:${stack.region}:${stack.account}:subnet/*`,
        `arn:aws:ec2:${stack.region}:${stack.account}:volume/*`,
        `arn:aws:ec2:${stack.region}:${stack.account}:launch-template/*`,
        // AMIs may live in other accounts (e.g. Amazon-owned base images)
        `arn:aws:ec2:${stack.region}::image/*`,
      ],
    }));

    // ec2:CreateFleet also requires permission on the fleet resource it creates
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ec2:CreateFleet'],
      resources: [`arn:aws:ec2:${stack.region}:${stack.account}:fleet/*`],
    }));

    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [props.runnerRoleArn],
    }));

    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      // Secrets Manager appends a 6-char random suffix to the ARN
      resources: [`arn:aws:secretsmanager:${stack.region}:${stack.account}:secret:${props.githubTokenSecretName}*`],
    }));

    this.functionArn = fn.functionArn;
    this.functionName = fn.functionName;
  }
}
