#!/opt/homebrew/opt/node/bin/node
import * as cdk from 'aws-cdk-lib/core';
import { GithubRunnerStack } from '../lib/github-runner/GithubRunnerStack';

const app = new cdk.App();

const githubOrg = process.env.GITHUB_ORG;
const githubTokenSecretName = process.env.GITHUB_TOKEN_SECRET_NAME;

if (githubOrg && githubTokenSecretName) {
  new GithubRunnerStack(app, 'GithubRunnerStack', {
    githubOrg,
    githubTokenSecretName,
    env: {
      account: process.env.CDK_DEFAULT_ACCOUNT,
      region: process.env.CDK_DEFAULT_REGION,
    },
  });
}
