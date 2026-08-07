import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export class RunnerBuildInstanceProfile extends Construct {
  readonly role: iam.Role;
  readonly name: string;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.role = new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('EC2InstanceProfileForImageBuilder'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    const profile = new iam.InstanceProfile(this, 'Profile', { role: this.role });
    this.name = profile.instanceProfileName;
  }
}
