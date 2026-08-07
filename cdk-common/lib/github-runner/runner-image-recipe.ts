import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as imagebuilder from 'aws-cdk-lib/aws-imagebuilder';
import { Construct } from 'constructs';

export class RunnerImageRecipe extends Construct {
  readonly arn: string;

  constructor(scope: Construct, id: string, runnerComponentArn: string) {
    super(scope, id);

    const region = cdk.Stack.of(this).region;
    const parentImage = ssm.StringParameter.valueForStringParameter(
      this,
      '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-x86_64'
    );

    const recipe = new imagebuilder.CfnImageRecipe(this, 'Recipe', {
      name: 'github-runner',
      version: '1.0.0',
      parentImage,
      components: [
        { componentArn: runnerComponentArn },
        { componentArn: `arn:aws:imagebuilder:${region}:aws:component/amazon-cloudwatch-agent-linux/1.x.x` },
      ],
    });
    this.arn = recipe.attrArn;
  }
}
