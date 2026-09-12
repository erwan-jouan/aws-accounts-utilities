import * as imagebuilder from 'aws-cdk-lib/aws-imagebuilder';
import { Construct } from 'constructs';

export interface RunnerImagePipelineProps {
  imageRecipeArn: string;
  infrastructureConfigurationArn: string;
}

export class RunnerImagePipeline extends Construct {
  constructor(scope: Construct, id: string, props: RunnerImagePipelineProps) {
    super(scope, id);

    new imagebuilder.CfnImagePipeline(this, 'Pipeline', {
      name: 'github-runner-pipeline',
      imageRecipeArn: props.imageRecipeArn,
      infrastructureConfigurationArn: props.infrastructureConfigurationArn,
      status: 'ENABLED',
      schedule: {
        scheduleExpression: 'cron(0 0 ? * SUN *)',
        pipelineExecutionStartCondition: 'EXPRESSION_MATCH_ONLY',
      },
    });
  }
}
