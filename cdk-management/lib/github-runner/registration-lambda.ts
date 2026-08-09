import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { Construct } from 'constructs';
import * as path from 'path';

export interface RegistrationLambdaProps {
  githubOrg: string;
  githubTokenSecretName: string;
}

export class RegistrationLambda extends Construct {
  constructor(scope: Construct, id: string, props: RegistrationLambdaProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);

    const fn = new lambdaNodejs.NodejsFunction(this, 'Fn', {
      entry: path.join(__dirname, 'lambda', 'registration-handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.minutes(10),
      environment: {
        GITHUB_ORG: props.githubOrg,
        GITHUB_TOKEN_SECRET_NAME: props.githubTokenSecretName,
      },
    });

    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ec2:DescribeInstances'],
      resources: ['*'],
    }));

    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'ssm:DescribeInstanceInformation',
        'ssm:GetCommandInvocation',
      ],
      resources: ['*'],
    }));

    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:SendCommand'],
      resources: [
        `arn:aws:ssm:${stack.region}::document/AWS-RunShellScript`,
        `arn:aws:ec2:${stack.region}:${stack.account}:instance/*`,
      ],
    }));

    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [
        `arn:aws:secretsmanager:${stack.region}:${stack.account}:secret:${props.githubTokenSecretName}*`,
      ],
    }));

    const rule = new events.Rule(this, 'Ec2RunningRule', {
      eventPattern: {
        source: ['aws.ec2'],
        detailType: ['EC2 Instance State-change Notification'],
        detail: { state: ['running'] },
      },
    });

    rule.addTarget(new targets.LambdaFunction(fn));
  }
}
