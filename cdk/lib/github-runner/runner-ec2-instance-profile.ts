import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface RunnerEc2InstanceProfileProps {
  githubTokenSecretName: string;
}

export class RunnerEc2InstanceProfile extends Construct {
  readonly name: string;
  readonly roleArn: string;

  constructor(scope: Construct, id: string, props: RunnerEc2InstanceProfileProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);

    const role = new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    // Allow runner to self-terminate after completing an ephemeral job,
    // scoped to instances tagged as runners to prevent privilege escalation.
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['ec2:TerminateInstances'],
      resources: ['*'],
      conditions: {
        StringEquals: { 'ec2:ResourceTag/github-runner': 'true' },
      },
    }));

    // Read the GitHub PAT from Secrets Manager during user data bootstrap
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [
        `arn:aws:secretsmanager:${stack.region}:${stack.account}:secret:${props.githubTokenSecretName}*`,
      ],
    }));

    const profile = new iam.InstanceProfile(this, 'Profile', { role });
    this.name = profile.instanceProfileName;
    this.roleArn = role.roleArn;
  }
}
