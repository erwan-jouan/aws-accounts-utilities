import {
  EC2Client,
  DescribeRegionsCommand,
  DescribeKeyPairsCommand,
  DescribeAddressesCommand,
  DescribeImagesCommand,
  paginateDescribeInstances,
  paginateDescribeVolumes,
  paginateDescribeSecurityGroups,
  paginateDescribeSnapshots,
  paginateDescribeVpcs,
  paginateDescribeSubnets,
  paginateDescribeInternetGateways,
  paginateDescribeNatGateways,
} from '@aws-sdk/client-ec2';
import { S3Client, ListBucketsCommand } from '@aws-sdk/client-s3';
import {
  IAMClient,
  PolicyScopeType,
  paginateListUsers,
  paginateListRoles,
  paginateListGroups,
  paginateListPolicies,
  paginateListEntitiesForPolicy,
} from '@aws-sdk/client-iam';
import {
  RDSClient,
  paginateDescribeDBInstances,
  paginateDescribeDBClusters,
} from '@aws-sdk/client-rds';
import { LambdaClient, paginateListFunctions } from '@aws-sdk/client-lambda';
import { DynamoDBClient, paginateListTables } from '@aws-sdk/client-dynamodb';
import {
  CloudFormationClient,
  paginateDescribeStacks,
} from '@aws-sdk/client-cloudformation';
import {
  ECSClient,
  paginateListClusters as paginateECSClusters,
} from '@aws-sdk/client-ecs';
import {
  EKSClient,
  paginateListClusters as paginateEKSClusters,
} from '@aws-sdk/client-eks';
import { SNSClient, paginateListTopics } from '@aws-sdk/client-sns';
import { SQSClient, paginateListQueues } from '@aws-sdk/client-sqs';
import {
  CloudFrontClient,
  ListDistributionsCommand,
} from '@aws-sdk/client-cloudfront';
import { Route53Client, paginateListHostedZones } from '@aws-sdk/client-route-53';

interface Resource {
  service: string;
  type: string;
  region: string;
  id: string;
  name: string;
  createdAt?: Date;
  usedBy: string[];
}

interface CollectionMeta {
  lambdaRoles: Map<string, string>;
  instanceSGIds: Map<string, string[]>;
  instanceVPCIds: Map<string, string>;
  instanceSubIds: Map<string, string>;
  cfS3Buckets: Map<string, string[]>;
}

function newMeta(): CollectionMeta {
  return {
    lambdaRoles: new Map(),
    instanceSGIds: new Map(),
    instanceVPCIds: new Map(),
    instanceSubIds: new Map(),
    cfS3Buckets: new Map(),
  };
}

function ec2TagName(tags?: { Key?: string; Value?: string }[]): string {
  if (!tags) return '-';
  return tags.find(t => t.Key === 'Name')?.Value ?? '-';
}

function parseFlexTime(s?: string): Date | undefined {
  if (!s) return undefined;
  if (s.endsWith('+0000')) s = s.slice(0, -5) + 'Z';
  const d = new Date(s);
  return isNaN(d.getTime()) ? undefined : d;
}

function fmtDate(d?: Date): string {
  if (!d) return '-';
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

async function getRegions(): Promise<string[]> {
  const client = new EC2Client({ region: 'us-east-1' });
  try {
    const result = await client.send(new DescribeRegionsCommand({}));
    return result.Regions?.map(r => r.RegionName!).filter(Boolean) ?? ['us-east-1'];
  } catch (e) {
    console.error(`warn: get regions: ${e}`);
    return ['us-east-1'];
  }
}

async function listEC2(region: string, meta: CollectionMeta): Promise<Resource[]> {
  const client = new EC2Client({ region });
  const resources: Resource[] = [];

  try {
    for await (const page of paginateDescribeInstances({ client }, {})) {
      for (const reservation of page.Reservations ?? []) {
        for (const instance of reservation.Instances ?? []) {
          const id = instance.InstanceId!;
          resources.push({
            service: 'EC2', type: 'Instance', region, id,
            name: ec2TagName(instance.Tags), createdAt: instance.LaunchTime, usedBy: [],
          });
          const sgs = (instance.SecurityGroups ?? []).map(sg => sg.GroupId!).filter(Boolean);
          if (sgs.length) meta.instanceSGIds.set(id, sgs);
          if (instance.VpcId) meta.instanceVPCIds.set(id, instance.VpcId);
          if (instance.SubnetId) meta.instanceSubIds.set(id, instance.SubnetId);
        }
      }
    }
  } catch (e) { console.error(`warn: EC2 instances ${region}: ${e}`); }

  try {
    for await (const page of paginateDescribeVolumes({ client }, {})) {
      for (const vol of page.Volumes ?? []) {
        resources.push({
          service: 'EC2', type: 'Volume', region, id: vol.VolumeId!,
          name: ec2TagName(vol.Tags), createdAt: vol.CreateTime, usedBy: [],
        });
      }
    }
  } catch (e) { console.error(`warn: EBS volumes ${region}: ${e}`); }

  try {
    for await (const page of paginateDescribeSecurityGroups({ client }, {})) {
      for (const sg of page.SecurityGroups ?? []) {
        resources.push({
          service: 'EC2', type: 'SecurityGroup', region, id: sg.GroupId!,
          name: sg.GroupName ?? '-', usedBy: [],
        });
      }
    }
  } catch (e) { console.error(`warn: security groups ${region}: ${e}`); }

  try {
    const result = await client.send(new DescribeKeyPairsCommand({}));
    for (const kp of result.KeyPairs ?? []) {
      resources.push({
        service: 'EC2', type: 'KeyPair', region, id: kp.KeyPairId ?? '-',
        name: kp.KeyName ?? '-', createdAt: kp.CreateTime, usedBy: [],
      });
    }
  } catch (e) { console.error(`warn: key pairs ${region}: ${e}`); }

  try {
    for await (const page of paginateDescribeSnapshots({ client }, { OwnerIds: ['self'] })) {
      for (const snap of page.Snapshots ?? []) {
        resources.push({
          service: 'EC2', type: 'Snapshot', region, id: snap.SnapshotId!,
          name: ec2TagName(snap.Tags), createdAt: snap.StartTime, usedBy: [],
        });
      }
    }
  } catch (e) { console.error(`warn: snapshots ${region}: ${e}`); }

  try {
    const result = await client.send(new DescribeAddressesCommand({}));
    for (const addr of result.Addresses ?? []) {
      const id = addr.AllocationId ?? addr.PublicIp ?? '-';
      resources.push({
        service: 'EC2', type: 'ElasticIP', region, id,
        name: addr.PublicIp ?? '-', usedBy: [],
      });
    }
  } catch (e) { console.error(`warn: elastic IPs ${region}: ${e}`); }

  try {
    const result = await client.send(new DescribeImagesCommand({ Owners: ['self'] }));
    for (const img of result.Images ?? []) {
      resources.push({
        service: 'EC2', type: 'AMI', region, id: img.ImageId!,
        name: img.Name ?? '-', createdAt: parseFlexTime(img.CreationDate), usedBy: [],
      });
    }
  } catch (e) { console.error(`warn: AMIs ${region}: ${e}`); }

  return resources;
}

async function listVPC(region: string): Promise<Resource[]> {
  const client = new EC2Client({ region });
  const resources: Resource[] = [];

  try {
    for await (const page of paginateDescribeVpcs({ client }, {})) {
      for (const vpc of page.Vpcs ?? []) {
        resources.push({
          service: 'VPC', type: 'VPC', region, id: vpc.VpcId!,
          name: ec2TagName(vpc.Tags), usedBy: [],
        });
      }
    }
  } catch (e) { console.error(`warn: VPCs ${region}: ${e}`); }

  try {
    for await (const page of paginateDescribeSubnets({ client }, {})) {
      for (const subnet of page.Subnets ?? []) {
        resources.push({
          service: 'VPC', type: 'Subnet', region, id: subnet.SubnetId!,
          name: ec2TagName(subnet.Tags), usedBy: [],
        });
      }
    }
  } catch (e) { console.error(`warn: subnets ${region}: ${e}`); }

  try {
    for await (const page of paginateDescribeInternetGateways({ client }, {})) {
      for (const igw of page.InternetGateways ?? []) {
        resources.push({
          service: 'VPC', type: 'InternetGateway', region, id: igw.InternetGatewayId!,
          name: ec2TagName(igw.Tags), usedBy: [],
        });
      }
    }
  } catch (e) { console.error(`warn: internet gateways ${region}: ${e}`); }

  try {
    for await (const page of paginateDescribeNatGateways({ client }, {})) {
      for (const ngw of page.NatGateways ?? []) {
        resources.push({
          service: 'VPC', type: 'NatGateway', region, id: ngw.NatGatewayId!,
          name: ec2TagName(ngw.Tags), createdAt: ngw.CreateTime, usedBy: [],
        });
      }
    }
  } catch (e) { console.error(`warn: NAT gateways ${region}: ${e}`); }

  return resources;
}

async function listS3(): Promise<Resource[]> {
  const client = new S3Client({ region: 'us-east-1' });
  const resources: Resource[] = [];

  try {
    const result = await client.send(new ListBucketsCommand({}));
    for (const bucket of result.Buckets ?? []) {
      const name = bucket.Name!;
      resources.push({
        service: 'S3', type: 'Bucket', region: 'global', id: name,
        name, createdAt: bucket.CreationDate, usedBy: [],
      });
    }
  } catch (e) { console.error(`warn: S3 buckets: ${e}`); }

  return resources;
}

async function listIAM(): Promise<Resource[]> {
  const client = new IAMClient({ region: 'us-east-1' });
  const resources: Resource[] = [];

  try {
    for await (const page of paginateListUsers({ client }, {})) {
      for (const user of page.Users ?? []) {
        resources.push({
          service: 'IAM', type: 'User', region: 'global', id: user.Arn!,
          name: user.UserName!, createdAt: user.CreateDate, usedBy: [],
        });
      }
    }
  } catch (e) { console.error(`warn: IAM users: ${e}`); }

  try {
    for await (const page of paginateListRoles({ client }, {})) {
      for (const role of page.Roles ?? []) {
        resources.push({
          service: 'IAM', type: 'Role', region: 'global', id: role.Arn!,
          name: role.RoleName!, createdAt: role.CreateDate, usedBy: [],
        });
      }
    }
  } catch (e) { console.error(`warn: IAM roles: ${e}`); }

  try {
    for await (const page of paginateListGroups({ client }, {})) {
      for (const group of page.Groups ?? []) {
        resources.push({
          service: 'IAM', type: 'Group', region: 'global', id: group.Arn!,
          name: group.GroupName!, createdAt: group.CreateDate, usedBy: [],
        });
      }
    }
  } catch (e) { console.error(`warn: IAM groups: ${e}`); }

  try {
    for await (const page of paginateListPolicies({ client }, { Scope: PolicyScopeType.Local })) {
      for (const policy of page.Policies ?? []) {
        const resource: Resource = {
          service: 'IAM', type: 'Policy', region: 'global', id: policy.Arn!,
          name: policy.PolicyName!, createdAt: policy.CreateDate, usedBy: [],
        };
        try {
          for await (const epage of paginateListEntitiesForPolicy({ client }, { PolicyArn: policy.Arn! })) {
            for (const role of epage.PolicyRoles ?? []) resource.usedBy.push(`${role.RoleName} (Role)`);
            for (const user of epage.PolicyUsers ?? []) resource.usedBy.push(`${user.UserName} (User)`);
            for (const group of epage.PolicyGroups ?? []) resource.usedBy.push(`${group.GroupName} (Group)`);
          }
        } catch (e) { console.error(`warn: IAM policy entities ${policy.PolicyName}: ${e}`); }
        resources.push(resource);
      }
    }
  } catch (e) { console.error(`warn: IAM policies: ${e}`); }

  return resources;
}

async function listRDS(region: string): Promise<Resource[]> {
  const client = new RDSClient({ region });
  const resources: Resource[] = [];

  try {
    for await (const page of paginateDescribeDBInstances({ client }, {})) {
      for (const db of page.DBInstances ?? []) {
        const id = db.DBInstanceIdentifier!;
        resources.push({
          service: 'RDS', type: 'DBInstance', region, id, name: id,
          createdAt: db.InstanceCreateTime, usedBy: [],
        });
      }
    }
  } catch (e) { console.error(`warn: RDS instances ${region}: ${e}`); }

  try {
    for await (const page of paginateDescribeDBClusters({ client }, {})) {
      for (const cluster of page.DBClusters ?? []) {
        const id = cluster.DBClusterIdentifier!;
        resources.push({
          service: 'RDS', type: 'DBCluster', region, id, name: id,
          createdAt: cluster.ClusterCreateTime, usedBy: [],
        });
      }
    }
  } catch (e) { console.error(`warn: RDS clusters ${region}: ${e}`); }

  return resources;
}

async function listLambda(region: string, meta: CollectionMeta): Promise<Resource[]> {
  const client = new LambdaClient({ region });
  const resources: Resource[] = [];

  try {
    for await (const page of paginateListFunctions({ client }, {})) {
      for (const fn of page.Functions ?? []) {
        const arn = fn.FunctionArn!;
        resources.push({
          service: 'Lambda', type: 'Function', region, id: arn,
          name: fn.FunctionName!, createdAt: parseFlexTime(fn.LastModified), usedBy: [],
        });
        if (fn.Role) meta.lambdaRoles.set(arn, fn.Role);
      }
    }
  } catch (e) { console.error(`warn: Lambda ${region}: ${e}`); }

  return resources;
}

async function listDynamoDB(region: string): Promise<Resource[]> {
  const client = new DynamoDBClient({ region });
  const resources: Resource[] = [];

  try {
    for await (const page of paginateListTables({ client }, {})) {
      for (const tableName of page.TableNames ?? []) {
        resources.push({
          service: 'DynamoDB', type: 'Table', region, id: tableName, name: tableName, usedBy: [],
        });
      }
    }
  } catch (e) { console.error(`warn: DynamoDB ${region}: ${e}`); }

  return resources;
}

async function listCloudFormation(region: string): Promise<Resource[]> {
  const client = new CloudFormationClient({ region });
  const resources: Resource[] = [];

  try {
    for await (const page of paginateDescribeStacks({ client }, {})) {
      for (const stack of page.Stacks ?? []) {
        resources.push({
          service: 'CloudFormation', type: 'Stack', region, id: stack.StackId!,
          name: stack.StackName!, createdAt: stack.CreationTime, usedBy: [],
        });
      }
    }
  } catch (e) { console.error(`warn: CloudFormation ${region}: ${e}`); }

  return resources;
}

async function listECS(region: string): Promise<Resource[]> {
  const client = new ECSClient({ region });
  const resources: Resource[] = [];

  try {
    for await (const page of paginateECSClusters({ client }, {})) {
      for (const arn of page.clusterArns ?? []) {
        resources.push({
          service: 'ECS', type: 'Cluster', region, id: arn, name: arn, usedBy: [],
        });
      }
    }
  } catch (e) { console.error(`warn: ECS ${region}: ${e}`); }

  return resources;
}

async function listEKS(region: string): Promise<Resource[]> {
  const client = new EKSClient({ region });
  const resources: Resource[] = [];

  try {
    for await (const page of paginateEKSClusters({ client }, {})) {
      for (const name of page.clusters ?? []) {
        resources.push({
          service: 'EKS', type: 'Cluster', region, id: name, name, usedBy: [],
        });
      }
    }
  } catch (e) { console.error(`warn: EKS ${region}: ${e}`); }

  return resources;
}

async function listSNS(region: string): Promise<Resource[]> {
  const client = new SNSClient({ region });
  const resources: Resource[] = [];

  try {
    for await (const page of paginateListTopics({ client }, {})) {
      for (const topic of page.Topics ?? []) {
        const arn = topic.TopicArn!;
        resources.push({
          service: 'SNS', type: 'Topic', region, id: arn, name: arn, usedBy: [],
        });
      }
    }
  } catch (e) { console.error(`warn: SNS ${region}: ${e}`); }

  return resources;
}

async function listSQS(region: string): Promise<Resource[]> {
  const client = new SQSClient({ region });
  const resources: Resource[] = [];

  try {
    for await (const page of paginateListQueues({ client }, {})) {
      for (const url of page.QueueUrls ?? []) {
        resources.push({
          service: 'SQS', type: 'Queue', region, id: url, name: url, usedBy: [],
        });
      }
    }
  } catch (e) { console.error(`warn: SQS ${region}: ${e}`); }

  return resources;
}

async function listCloudFront(meta: CollectionMeta): Promise<Resource[]> {
  const client = new CloudFrontClient({ region: 'us-east-1' });
  const resources: Resource[] = [];
  let marker: string | undefined;

  try {
    while (true) {
      const result = await client.send(new ListDistributionsCommand({ Marker: marker }));
      const list = result.DistributionList;
      if (!list) break;

      for (const dist of list.Items ?? []) {
        const distId = dist.Id!;
        resources.push({
          service: 'CloudFront', type: 'Distribution', region: 'global', id: distId,
          name: dist.DomainName!, createdAt: dist.LastModifiedTime, usedBy: [],
        });
        for (const origin of dist.Origins?.Items ?? []) {
          const domain = origin.DomainName ?? '';
          const idx = domain.indexOf('.s3.');
          if (idx > 0) {
            const existing = meta.cfS3Buckets.get(distId) ?? [];
            existing.push(domain.slice(0, idx));
            meta.cfS3Buckets.set(distId, existing);
          }
        }
      }

      if (!list.IsTruncated) break;
      marker = list.NextMarker;
    }
  } catch (e) { console.error(`warn: CloudFront: ${e}`); }

  return resources;
}

async function listRoute53(): Promise<Resource[]> {
  const client = new Route53Client({ region: 'us-east-1' });
  const resources: Resource[] = [];

  try {
    for await (const page of paginateListHostedZones({ client }, {})) {
      for (const zone of page.HostedZones ?? []) {
        resources.push({
          service: 'Route53', type: 'HostedZone', region: 'global', id: zone.Id!,
          name: zone.Name!, usedBy: [],
        });
      }
    }
  } catch (e) { console.error(`warn: Route53: ${e}`); }

  return resources;
}

function resolveUsedBy(resources: Resource[], meta: CollectionMeta): void {
  const instanceNames = new Map<string, string>();
  const lambdaNames = new Map<string, string>();

  for (const r of resources) {
    if (r.service === 'EC2' && r.type === 'Instance') {
      instanceNames.set(r.id, r.name === '-' || r.name === '' ? r.id : r.name);
    } else if (r.service === 'Lambda' && r.type === 'Function') {
      lambdaNames.set(r.id, r.name);
    }
  }

  const sgToInst = new Map<string, string[]>();
  for (const [id, sgs] of meta.instanceSGIds) {
    const name = instanceNames.get(id) ?? id;
    for (const sg of sgs) {
      const arr = sgToInst.get(sg) ?? [];
      arr.push(name);
      sgToInst.set(sg, arr);
    }
  }

  const vpcToInst = new Map<string, string[]>();
  for (const [id, vpc] of meta.instanceVPCIds) {
    const arr = vpcToInst.get(vpc) ?? [];
    arr.push(instanceNames.get(id) ?? id);
    vpcToInst.set(vpc, arr);
  }

  const subToInst = new Map<string, string[]>();
  for (const [id, sub] of meta.instanceSubIds) {
    const arr = subToInst.get(sub) ?? [];
    arr.push(instanceNames.get(id) ?? id);
    subToInst.set(sub, arr);
  }

  const roleToLambda = new Map<string, string[]>();
  for (const [fnArn, roleArn] of meta.lambdaRoles) {
    const arr = roleToLambda.get(roleArn) ?? [];
    arr.push(lambdaNames.get(fnArn) ?? fnArn);
    roleToLambda.set(roleArn, arr);
  }

  const bucketToCF = new Map<string, string[]>();
  for (const [distId, buckets] of meta.cfS3Buckets) {
    for (const b of buckets) {
      const arr = bucketToCF.get(b) ?? [];
      arr.push(distId);
      bucketToCF.set(b, arr);
    }
  }

  for (const r of resources) {
    if (r.service === 'IAM' && r.type === 'Role') {
      for (const fn of roleToLambda.get(r.id) ?? []) r.usedBy.push(`${fn} (Lambda)`);
    } else if (r.service === 'EC2' && r.type === 'SecurityGroup') {
      for (const inst of sgToInst.get(r.id) ?? []) r.usedBy.push(`${inst} (EC2)`);
    } else if (r.service === 'VPC' && r.type === 'VPC') {
      for (const inst of vpcToInst.get(r.id) ?? []) r.usedBy.push(`${inst} (EC2)`);
    } else if (r.service === 'VPC' && r.type === 'Subnet') {
      for (const inst of subToInst.get(r.id) ?? []) r.usedBy.push(`${inst} (EC2)`);
    } else if (r.service === 'S3' && r.type === 'Bucket') {
      for (const dist of bucketToCF.get(r.name) ?? []) r.usedBy.push(`${dist} (CloudFront)`);
    }
  }
}

function printTable(resources: Resource[]): void {
  const headers = ['SERVICE', 'TYPE', 'REGION', 'ID', 'NAME', 'CREATED', 'USED BY'];
  const widths = headers.map(h => h.length);

  const rows = resources.map(r => [
    r.service, r.type, r.region, r.id, r.name,
    fmtDate(r.createdAt), r.usedBy.join(', '),
  ]);

  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      widths[i] = Math.max(widths[i], row[i].length);
    }
  }

  const pad = (s: string, w: number) => s.padEnd(w);
  console.log(headers.map((h, i) => pad(h, widths[i])).join('  '));
  console.log(widths.map(w => '-'.repeat(w)).join('  '));
  for (const row of rows) {
    console.log(row.map((c, i) => pad(c, widths[i])).join('  '));
  }
}

async function main(): Promise<void> {
  console.error('Discovering regions...');
  const regions = await getRegions();
  console.error(`Scanning ${regions.length} regions across 14 services...`);

  const meta = newMeta();
  const allResources: Resource[] = [];

  const globalResults = await Promise.all([
    listS3(),
    listIAM(),
    listCloudFront(meta),
    listRoute53(),
  ]);
  for (const r of globalResults) allResources.push(...r);

  const regionalResults = await Promise.all(
    regions.map(region =>
      Promise.all([
        listEC2(region, meta),
        listVPC(region),
        listRDS(region),
        listLambda(region, meta),
        listDynamoDB(region),
        listCloudFormation(region),
        listECS(region),
        listEKS(region),
        listSNS(region),
        listSQS(region),
      ]).then(results => results.flat())
    )
  );
  for (const r of regionalResults) allResources.push(...r);

  resolveUsedBy(allResources, meta);

  allResources.sort((a, b) => {
    if (!a.createdAt && !b.createdAt) return 0;
    if (!a.createdAt) return 1;
    if (!b.createdAt) return -1;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });

  printTable(allResources);
  console.error(`\nTotal: ${allResources.length} resources found`);
}

main().catch(e => {
  console.error(`Fatal: ${e}`);
  process.exit(1);
});
