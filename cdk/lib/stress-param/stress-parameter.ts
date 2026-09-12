import { Construct } from 'constructs';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import * as cdk from "aws-cdk-lib/core";

export class StressParameter extends Construct {
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id);

        new StringParameter(this, 'Parameter', {
            parameterName: '/custom/stress',
            stringValue: 'false',
        });
    }
}
