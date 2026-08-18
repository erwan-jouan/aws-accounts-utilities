import * as imagebuilder from 'aws-cdk-lib/aws-imagebuilder';
import { Construct } from 'constructs';
import * as path from 'path';
import * as fs from 'fs';

export class RunnerComponent extends Construct {
  readonly arn: string;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    const data = fs.readFileSync(
      path.join(__dirname, 'template', 'runner-component.yml'),
      { encoding: 'utf-8' }
    );

    const component = new imagebuilder.CfnComponent(this, 'Component', {
      name: 'github-runner',
      platform: 'Linux',
      version: '1.0.1',
      description: 'Installs Node.js 20 and GitHub Actions runner binary',
      data,
      supportedOsVersions: ['Amazon Linux 2023'],
    });
    this.arn = component.attrArn;
  }
}
