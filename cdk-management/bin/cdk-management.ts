#!/opt/homebrew/opt/node/bin/node
import * as cdk from 'aws-cdk-lib/core';
import { GithubRunnerStack } from '../lib/github-runner/GithubRunnerStack';

const app = new cdk.App();

const githubOrg = process.env.GH_ORG;
const githubTokenSecretName = process.env.GH_TOKEN_SECRET_NAME;

if (!githubOrg) throw new Error('Missing required env var: GH_ORG');
if (!githubTokenSecretName) throw new Error('Missing required env var: GH_TOKEN_SECRET_NAME');

new GithubRunnerStack(app, 'GithubRunnerStack', {
  githubOrg,
  githubTokenSecretName,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
