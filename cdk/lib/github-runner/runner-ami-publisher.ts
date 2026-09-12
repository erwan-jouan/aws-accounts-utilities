import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import { Match } from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import * as path from 'path';

export const LATEST_AMI_PARAM = '/github-runner/latest-ami-id';

export class RunnerAmiPublisher extends Construct {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    const stack = cdk.Stack.of(this);

    const fn = new lambdaNodejs.NodejsFunction(this, 'Fn', {
      entry: path.join(__dirname, 'lambda', 'ami-publisher-handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(30),
      environment: {
        PARAM_NAME: LATEST_AMI_PARAM,
      },
    });

    // DescribeImages does not support resource-level permissions
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ec2:DescribeImages'],
      resources: ['*'],
    }));

    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ec2:CreateTags', 'ec2:DeregisterImage'],
      resources: [`arn:aws:ec2:${stack.region}:${stack.account}:image/*`],
    }));

    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ec2:DeleteSnapshot'],
      resources: [`arn:aws:ec2:${stack.region}:${stack.account}:snapshot/*`],
    }));

    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:PutParameter'],
      resources: [`arn:aws:ssm:${stack.region}:${stack.account}:parameter${LATEST_AMI_PARAM}`],
    }));

    new events.Rule(this, 'Rule', {
      description: 'Writes the github-runner AMI ID to SSM when the Image Builder pipeline produces a new image',
      eventPattern: {
        source: ['aws.imagebuilder'],
        detailType: ['EC2 Image Builder Image State Change'],
        // Scope to the github-runner recipe only — avoids triggering on other pipelines
        resources: Match.prefix(
          `arn:aws:imagebuilder:${stack.region}:${stack.account}:image/github-runner/`,
        ),
        detail: {
          state: { status: ['AVAILABLE'] },
        },
      },
      targets: [new targets.LambdaFunction(fn)],
    });
  }
}
