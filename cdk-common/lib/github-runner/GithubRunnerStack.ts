import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { RunnerBuildInstanceProfile } from './runner-build-instance-profile';
import { RunnerInfrastructureConfig } from './runner-infrastructure-config';
import { RunnerComponent } from './runner-component';
import { RunnerImageRecipe } from './runner-image-recipe';
import { RunnerImagePipeline } from './runner-image-pipeline';
import { RunnerEc2InstanceProfile } from './runner-ec2-instance-profile';
import { RegistrationLambda } from './registration-lambda';

export interface GithubRunnerStackProps extends cdk.StackProps {
  githubOrg: string;
  githubTokenSecretName: string;
}

export class GithubRunnerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: GithubRunnerStackProps) {
    super(scope, id, props);

    const buildProfile = new RunnerBuildInstanceProfile(this, 'BuildProfile');
    const infraConfig = new RunnerInfrastructureConfig(this, 'InfraConfig', buildProfile.name);
    infraConfig.logBucket.grantWrite(buildProfile.role);

    const component = new RunnerComponent(this, 'Component');
    const recipe = new RunnerImageRecipe(this, 'Recipe', component.arn);

    new RunnerImagePipeline(this, 'Pipeline', {
      imageRecipeArn: recipe.arn,
      infrastructureConfigurationArn: infraConfig.arn,
    });

    const runnerProfile = new RunnerEc2InstanceProfile(this, 'RunnerProfile');

    new RegistrationLambda(this, 'RegistrationLambda', {
      githubOrg: props.githubOrg,
      githubTokenSecretName: props.githubTokenSecretName,
    });

    new cdk.CfnOutput(this, 'RunnerInstanceProfileName', {
      value: runnerProfile.name,
      description: 'Attach to EC2 instances that should act as GitHub runners (also tag them github-runner=true)',
      exportName: `${this.stackName}-RunnerInstanceProfileName`,
    });

    new cdk.CfnOutput(this, 'ImageBuilderPipelineName', {
      value: 'github-runner-pipeline',
      description: 'Run this EC2 Image Builder pipeline to bake the runner AMI before first use',
    });
  }
}
