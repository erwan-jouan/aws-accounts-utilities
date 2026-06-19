import { DynamoDBStreamEvent } from 'aws-lambda';
import { CloudFormationClient, DeleteStackCommand } from '@aws-sdk/client-cloudformation';

const cfn = new CloudFormationClient({});

export const handler = async (event: DynamoDBStreamEvent): Promise<void> => {
  for (const record of event.Records) {
    if (record.eventName !== 'REMOVE' || record.userIdentity?.type !== 'Service') continue;

    const stackName = record.dynamodb?.OldImage?.pk?.S;
    if (!stackName) continue;

    console.log(`TTL expired — deleting stack: ${stackName}`);
    await cfn.send(new DeleteStackCommand({ StackName: stackName }));
    console.log(`DeleteStack request sent for ${stackName}`);
  }
};
