import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { RunnerBuildInstanceProfile } from './runner-build-instance-profile';
import { RunnerInfrastructureConfig } from './runner-infrastructure-config';
import { RunnerComponent } from './runner-component';
import { RunnerImageRecipe } from './runner-image-recipe';
import { RunnerImagePipeline } from './runner-image-pipeline';
import { RunnerEc2InstanceProfile } from './runner-ec2-instance-profile';
import { RegistrationLambda } from './registration-lambda';
import { RunnerAmiPublisher, LATEST_AMI_PARAM } from './runner-ami-publisher';

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

    new RunnerAmiPublisher(this, 'AmiPublisher');

    const runnerProfile = new RunnerEc2InstanceProfile(this, 'RunnerProfile', {
      githubTokenSecretName: props.githubTokenSecretName,
    });

    const registrationLambda = new RegistrationLambda(this, 'RegistrationLambda', {
      githubOrg: props.githubOrg,
      githubTokenSecretName: props.githubTokenSecretName,
      runnerInstanceProfileName: runnerProfile.name,
      runnerRoleArn: runnerProfile.roleArn,
    });

    new ssm.StringParameter(this, 'LauncherFunctionNameParam', {
      parameterName: '/github-runner/launcher-function-name',
      stringValue: registrationLambda.functionName,
      description: 'GitHub Actions runner launcher Lambda — read by the launch-runner workflow job via aws ssm get-parameter',
    });

    new cdk.CfnOutput(this, 'RunnerLauncherFunctionName', {
      value: registrationLambda.functionName,
      description: 'Lambda function name — also stored at SSM /github-runner/launcher-function-name',
      exportName: `${this.stackName}-RunnerLauncherFunctionName`,
    });

    new cdk.CfnOutput(this, 'RunnerInstanceProfileName', {
      value: runnerProfile.name,
      description: 'Instance profile attached to EC2 runner instances by the launcher Lambda',
      exportName: `${this.stackName}-RunnerInstanceProfileName`,
    });

    new cdk.CfnOutput(this, 'ImageBuilderPipelineName', {
      value: 'github-runner-pipeline',
      description: 'Run this EC2 Image Builder pipeline to bake the runner AMI before first use',
    });

    new cdk.CfnOutput(this, 'LatestAmiParam', {
      value: LATEST_AMI_PARAM,
      description: 'SSM parameter written by the Image Builder pipeline on each successful build',
    });
  }
}
