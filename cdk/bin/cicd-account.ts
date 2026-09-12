import {AutoDeleteStack} from "../lib/auto-delete-stack/auto-delete-stack";
import * as cdk from "aws-cdk-lib/core";
import {GithubRunnerStack} from "../lib/github-runner/GithubRunnerStack";

const app = new cdk.App();

const autoDeleteStack = 'auto-delete-stack';
new AutoDeleteStack(app, autoDeleteStack, {
    stackName: autoDeleteStack,
    env: {
        account: process.env.CICD_ACCOUNT_ID,
        region: process.env.CDK_DEFAULT_REGION,
    }
})

const githubOrg = process.env.GH_ORG;
const githubTokenSecretName = process.env.GH_TOKEN_SECRET_NAME;

if (!githubOrg) throw new Error('Missing required env var: GH_ORG');
if (!githubTokenSecretName) throw new Error('Missing required env var: GH_TOKEN_SECRET_NAME');

new GithubRunnerStack(app, 'github-runner-stack', {
    githubOrg,
    githubTokenSecretName,
    env: {
        account: process.env.CICD_ACCOUNT_ID,
        region: process.env.CDK_DEFAULT_REGION,
    },
});