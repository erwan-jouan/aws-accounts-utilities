import * as cdk from 'aws-cdk-lib/core';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import * as path from 'path';

export class CdkCommonStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const table = new dynamodb.TableV2(this, 'AutokilledTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'ttl',
      dynamoStream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      billing: dynamodb.Billing.onDemand(),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const deletionExecutorFn = new lambdaNodejs.NodejsFunction(this, 'DeletionExecutorFn', {
      entry: path.join(__dirname, '../lambda/deletion-executor.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(30),
    });

    deletionExecutorFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudformation:DeleteStack'],
      resources: [`arn:aws:cloudformation:${this.region}:${this.account}:stack/*/*`],
    }));

    deletionExecutorFn.addEventSource(new lambdaEventSources.DynamoEventSource(table, {
      startingPosition: lambda.StartingPosition.LATEST,
      filters: [lambda.FilterCriteria.filter({
        eventName: lambda.FilterRule.isEqual('REMOVE'),
        userIdentity: { type: lambda.FilterRule.isEqual('Service') },
      })],
    }));

    const deletionSchedulerFn = new lambdaNodejs.NodejsFunction(this, 'DeletionSchedulerFn', {
      entry: path.join(__dirname, '../lambda/deletion-scheduler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(30),
      environment: {
        TABLE_NAME: table.tableName,
      },
    });

    // grantWriteData covers PutItem and DeleteItem (used by Create/Update and Delete request types)
    table.grantWriteData(deletionSchedulerFn);

    new cdk.CfnOutput(this, 'DeletionSchedulerFnArn', {
      description: 'ARN of the deletion scheduler Lambda — use as ServiceToken in custom resources',
      value: deletionSchedulerFn.functionArn,
      exportName: `${this.stackName}-DeletionSchedulerFnArn`,
    });
  }
}
