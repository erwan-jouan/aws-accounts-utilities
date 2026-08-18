import {
  EC2Client,
  DescribeImagesCommand,
  CreateTagsCommand,
  DeregisterImageCommand,
  DeleteSnapshotCommand,
} from '@aws-sdk/client-ec2';
import { SSMClient, PutParameterCommand } from '@aws-sdk/client-ssm';

const ec2 = new EC2Client({});
const ssm = new SSMClient({});
const PARAM_NAME = process.env.PARAM_NAME!;

interface AmiInfo {
  id: string;
  name: string;
  snapshotIds: string[];
}

async function findAllRunnerAmis(): Promise<AmiInfo[]> {
  const { Images = [] } = await ec2.send(new DescribeImagesCommand({
    Owners: ['self'],
    Filters: [
      { Name: 'name', Values: ['github-runner*'] },
      { Name: 'state', Values: ['available'] },
    ],
  }));
  Images.sort((a, b) => (b.CreationDate ?? '').localeCompare(a.CreationDate ?? ''));
  return Images.map(img => ({
    id: img.ImageId!,
    name: img.Name ?? img.ImageId!,
    snapshotIds: (img.BlockDeviceMappings ?? [])
      .map(bdm => bdm.Ebs?.SnapshotId)
      .filter((id): id is string => Boolean(id)),
  }));
}

async function deregisterAndClean(ami: AmiInfo): Promise<void> {
  await ec2.send(new DeregisterImageCommand({ ImageId: ami.id }));
  console.log(`Deregistered old AMI ${ami.id} (${ami.name})`);
  for (const snapshotId of ami.snapshotIds) {
    await ec2.send(new DeleteSnapshotCommand({ SnapshotId: snapshotId }));
    console.log(`Deleted snapshot ${snapshotId}`);
  }
}

export async function handler(_event: unknown): Promise<void> {
  const amis = await findAllRunnerAmis();
  if (!amis.length) throw new Error('No available github-runner AMI found');

  const [latest, ...older] = amis;

  // Tag the new AMI
  await ec2.send(new CreateTagsCommand({
    Resources: [latest.id],
    Tags: [{ Key: 'Name', Value: 'github-runner' }],
  }));
  console.log(`Tagged ${latest.id} with Name=github-runner`);

  // Publish to SSM — do this before cleanup so a cleanup failure doesn't block consumers
  await ssm.send(new PutParameterCommand({
    Name: PARAM_NAME,
    Value: latest.id,
    Type: 'String',
    Overwrite: true,
    Description: 'Latest github-runner AMI ID — updated automatically when the Image Builder pipeline completes',
  }));
  console.log(`Published ${PARAM_NAME} = ${latest.id} (${latest.name})`);

  // Deregister older AMIs and delete their backing snapshots
  for (const ami of older) {
    try {
      await deregisterAndClean(ami);
    } catch (err) {
      // Log but don't fail — SSM is already updated; cleanup can succeed on next run
      console.warn(`Failed to clean up old AMI ${ami.id}: ${err}`);
    }
  }
  if (older.length) console.log(`Cleaned up ${older.length} older AMI(s)`);
}
