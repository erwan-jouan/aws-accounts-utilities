import * as cdk from 'aws-cdk-lib';
import * as imagebuilder from 'aws-cdk-lib/aws-imagebuilder';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export class RunnerInfrastructureConfig extends Construct {
  readonly logBucket: s3.Bucket;
  readonly arn: string;

  constructor(scope: Construct, id: string, instanceProfileName: string) {
    super(scope, id);

    this.logBucket = new s3.Bucket(this, 'LogBucket', {
      lifecycleRules: [{ expiration: cdk.Duration.days(90) }],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const config = new imagebuilder.CfnInfrastructureConfiguration(this, 'Config', {
      name: 'github-runner-build',
      instanceProfileName,
      instanceTypes: ['t3.medium'],
      logging: {
        s3Logs: {
          s3BucketName: this.logBucket.bucketName,
          s3KeyPrefix: 'image-builder/',
        },
      },
    });
    this.arn = config.attrArn;
  }
}
