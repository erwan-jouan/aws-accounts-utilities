import { CloudFormationCustomResourceEvent } from 'aws-lambda';
import { DynamoDBClient, PutItemCommand, DeleteItemCommand } from '@aws-sdk/client-dynamodb';
import * as https from 'https';
import * as url from 'url';

const dynamo = new DynamoDBClient({});

async function sendResponse(
  event: CloudFormationCustomResourceEvent,
  status: 'SUCCESS' | 'FAILED',
  reason?: string,
): Promise<void> {
  const body = JSON.stringify({
    Status: status,
    Reason: reason ?? 'See CloudWatch logs',
    PhysicalResourceId: event.ResourceProperties.StackName ?? event.LogicalResourceId,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    Data: {},
  });

  const parsed = url.parse(event.ResponseURL);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: parsed.hostname,
        path: parsed.path,
        method: 'PUT',
        headers: { 'Content-Type': '', 'Content-Length': Buffer.byteLength(body) },
      },
      () => resolve(),
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

export const handler = async (event: CloudFormationCustomResourceEvent): Promise<void> => {
  const tableName = process.env.TABLE_NAME!;
  const stackName = event.ResourceProperties.StackName as string;
  const ttlSeconds = parseInt(event.ResourceProperties.TtlSeconds as string, 10);

  try {
    if (event.RequestType === 'Create' || event.RequestType === 'Update') {
      const ttl = Math.floor(Date.now() / 1000) + ttlSeconds;
      await dynamo.send(new PutItemCommand({
        TableName: tableName,
        Item: {
          pk: { S: stackName },
          ttl: { N: String(ttl) },
        },
      }));
      console.log(`Deletion scheduled for ${stackName} at ${new Date(ttl * 1000).toISOString()}`);
    } else if (event.RequestType === 'Delete') {
      await dynamo.send(new DeleteItemCommand({
        TableName: tableName,
        Key: { pk: { S: stackName } },
      }));
      console.log(`Deletion cancelled for ${stackName}`);
    }
    await sendResponse(event, 'SUCCESS');
  } catch (err) {
    console.error(err);
    await sendResponse(event, 'FAILED', (err as Error).message);
  }
};
