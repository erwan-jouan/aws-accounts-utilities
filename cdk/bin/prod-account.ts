import * as cdk from "aws-cdk-lib/core";
import {AutoDeleteStack} from "../lib/auto-delete-stack/auto-delete-stack";
import {StressParameter} from "../lib/stress-param/stress-parameter";

const app = new cdk.App();

const autoDeleteStackForProd = 'auto-delete-stack';
new AutoDeleteStack(app, autoDeleteStackForProd, {
    stackName: autoDeleteStackForProd,
    env: {
        account: process.env.PROD_ACCOUNT_ID,
        region: process.env.CDK_DEFAULT_REGION,
    }
});

const stressParameter = 'stress-parameter-stack';
new StressParameter(app, stressParameter, {
    stackName: stressParameter,
    env: {
        account: process.env.PROD_ACCOUNT_ID,
        region: process.env.CDK_DEFAULT_REGION,
    }
});