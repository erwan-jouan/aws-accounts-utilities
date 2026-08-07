import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export class RunnerEc2InstanceProfile extends Construct {
  readonly name: string;

  constructor(scope: Construct, id: string) {
    super(scope, id);

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

    const profile = new iam.InstanceProfile(this, 'Profile', { role });
    this.name = profile.instanceProfileName;
  }
}
