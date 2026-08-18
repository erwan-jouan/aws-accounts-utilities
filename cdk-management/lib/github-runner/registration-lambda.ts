import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import * as path from 'path';

export interface RegistrationLambdaProps {
  githubOrg: string;
  githubTokenSecretName: string;
  runnerInstanceProfileName: string;
  runnerRoleArn: string;
  subnetId?: string;
  instanceType?: string;
}

export class RegistrationLambda extends Construct {
  readonly functionArn: string;
  readonly functionName: string;

  constructor(scope: Construct, id: string, props: RegistrationLambdaProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);

    const fn = new lambdaNodejs.NodejsFunction(this, 'Fn', {
      entry: path.join(__dirname, 'lambda', 'registration-handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      // Waits up to 10 min for EC2 running + 8 min for runner to register; 20 min gives headroom
      timeout: cdk.Duration.minutes(12),
      environment: {
        GH_ORG: props.githubOrg,
        GH_TOKEN_SECRET_NAME: props.githubTokenSecretName,
        RUNNER_INSTANCE_PROFILE_NAME: props.runnerInstanceProfileName,
        ...(props.subnetId ? { RUNNER_SUBNET_ID: props.subnetId } : {}),
        ...(props.instanceType ? { RUNNER_INSTANCE_TYPE: props.instanceType } : {}),
      },
    });

    // DescribeInstanceStatus does not support resource-level permissions
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ec2:DescribeInstanceStatus'],
      resources: ['*'],
    }));

    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${stack.region}:${stack.account}:parameter/github-runner/latest-ami-id`],
    }));

    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ec2:RunInstances'],
      resources: [
        `arn:aws:ec2:${stack.region}:${stack.account}:instance/*`,
        `arn:aws:ec2:${stack.region}:${stack.account}:image/*`,
        `arn:aws:ec2:${stack.region}:${stack.account}:network-interface/*`,
        `arn:aws:ec2:${stack.region}:${stack.account}:security-group/*`,
        `arn:aws:ec2:${stack.region}:${stack.account}:subnet/*`,
        `arn:aws:ec2:${stack.region}:${stack.account}:volume/*`,
        // AMIs may live in other accounts (e.g. Amazon-owned base images)
        `arn:aws:ec2:${stack.region}::image/*`,
      ],
    }));

    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ec2:CreateTags'],
      resources: [`arn:aws:ec2:${stack.region}:${stack.account}:instance/*`],
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
