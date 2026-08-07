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
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';

interface Resource {
  service: string;
  type: string;
  region: string;
  id: string;
}

interface CollectionMeta {
  subnetVpcIds: Map<string, string>;         // subnetId -> vpcId
  igwVpcIds: Map<string, string>;            // igwId -> vpcId
  ngwSubnetIds: Map<string, string>;         // ngwId -> subnetId
  sgVpcIds: Map<string, string>;             // sgId -> vpcId
  volumeInstanceIds: Map<string, string>;    // volumeId -> instanceId
  dbInstanceClusterIds: Map<string, string>; // dbInstanceId -> clusterId
  instanceSubIds: Map<string, string>;       // instanceId -> subnetId
}

function newMeta(): CollectionMeta {
  return {
    subnetVpcIds: new Map(),
    igwVpcIds: new Map(),
    ngwSubnetIds: new Map(),
    sgVpcIds: new Map(),
    volumeInstanceIds: new Map(),
    dbInstanceClusterIds: new Map(),
    instanceSubIds: new Map(),
  };
}

function parseFlexTime(s?: string): Date | undefined {
  if (!s) return undefined;
  if (s.endsWith('+0000')) s = s.slice(0, -5) + 'Z';
  const d = new Date(s);
  return isNaN(d.getTime()) ? undefined : d;
}

async function getAccountId(): Promise<string> {
  const client = new STSClient({ region: 'us-east-1' });
  try {
    const result = await client.send(new GetCallerIdentityCommand({}));
    return result.Account ?? 'unknown';
  } catch (e) {
    console.error(`warn: get account ID: ${e}`);
    return 'unknown';
  }
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

function toArn(r: Resource, accountId: string): string {
  switch (r.service) {
    case 'EC2':
      switch (r.type) {
        case 'Instance':      return `arn:aws:ec2:${r.region}:${accountId}:instance/${r.id}`;
        case 'Volume':        return `arn:aws:ec2:${r.region}:${accountId}:volume/${r.id}`;
        case 'SecurityGroup': return `arn:aws:ec2:${r.region}:${accountId}:security-group/${r.id}`;
        case 'KeyPair':       return `arn:aws:ec2:${r.region}:${accountId}:key-pair/${r.id}`;
        case 'Snapshot':      return `arn:aws:ec2:${r.region}:${accountId}:snapshot/${r.id}`;
        case 'ElasticIP':     return `arn:aws:ec2:${r.region}:${accountId}:elastic-ip/${r.id}`;
        case 'AMI':           return `arn:aws:ec2:${r.region}:${accountId}:image/${r.id}`;
        default:              return `arn:aws:ec2:${r.region}:${accountId}:${r.type.toLowerCase()}/${r.id}`;
      }
    case 'VPC':
      switch (r.type) {
        case 'VPC':             return `arn:aws:ec2:${r.region}:${accountId}:vpc/${r.id}`;
        case 'Subnet':          return `arn:aws:ec2:${r.region}:${accountId}:subnet/${r.id}`;
        case 'InternetGateway': return `arn:aws:ec2:${r.region}:${accountId}:internet-gateway/${r.id}`;
        case 'NatGateway':      return `arn:aws:ec2:${r.region}:${accountId}:natgateway/${r.id}`;
        default:                return `arn:aws:ec2:${r.region}:${accountId}:${r.type.toLowerCase()}/${r.id}`;
      }
    case 'S3':             return `arn:aws:s3:::${r.id}`;
    case 'IAM':            return r.id; // already an ARN
    case 'RDS':
      if (r.type === 'DBCluster') return `arn:aws:rds:${r.region}:${accountId}:cluster:${r.id}`;
      return `arn:aws:rds:${r.region}:${accountId}:db:${r.id}`;
    case 'Lambda':         return r.id; // already an ARN
    case 'DynamoDB':       return `arn:aws:dynamodb:${r.region}:${accountId}:table/${r.id}`;
    case 'CloudFormation': return r.id; // already an ARN
    case 'ECS':            return r.id; // already an ARN
    case 'EKS':            return `arn:aws:eks:${r.region}:${accountId}:cluster/${r.id}`;
    case 'SNS':            return r.id; // already an ARN
    case 'SQS': {
      const parts = r.id.split('/');
      const queueName = parts[parts.length - 1];
      return `arn:aws:sqs:${r.region}:${accountId}:${queueName}`;
    }
    case 'CloudFront':  return `arn:aws:cloudfront::${accountId}:distribution/${r.id}`;
    case 'Route53': {
      const zoneId = r.id.split('/').pop() ?? r.id;
      return `arn:aws:route53:::hostedzone/${zoneId}`;
    }
    default: return r.id;
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
          resources.push({ service: 'EC2', type: 'Instance', region, id });
          if (instance.SubnetId) meta.instanceSubIds.set(id, instance.SubnetId);
        }
      }
    }
  } catch (e) { console.error(`warn: EC2 instances ${region}: ${e}`); }

  try {
    for await (const page of paginateDescribeVolumes({ client }, {})) {
      for (const vol of page.Volumes ?? []) {
        resources.push({ service: 'EC2', type: 'Volume', region, id: vol.VolumeId! });
        const instanceId = vol.Attachments?.[0]?.InstanceId;
        if (instanceId) meta.volumeInstanceIds.set(vol.VolumeId!, instanceId);
      }
    }
  } catch (e) { console.error(`warn: EBS volumes ${region}: ${e}`); }

  try {
    for await (const page of paginateDescribeSecurityGroups({ client }, {})) {
      for (const sg of page.SecurityGroups ?? []) {
        resources.push({ service: 'EC2', type: 'SecurityGroup', region, id: sg.GroupId! });
        if (sg.VpcId) meta.sgVpcIds.set(sg.GroupId!, sg.VpcId);
      }
    }
  } catch (e) { console.error(`warn: security groups ${region}: ${e}`); }

  try {
    const result = await client.send(new DescribeKeyPairsCommand({}));
    for (const kp of result.KeyPairs ?? []) {
      resources.push({ service: 'EC2', type: 'KeyPair', region, id: kp.KeyPairId ?? kp.KeyName! });
    }
  } catch (e) { console.error(`warn: key pairs ${region}: ${e}`); }

  try {
    for await (const page of paginateDescribeSnapshots({ client }, { OwnerIds: ['self'] })) {
      for (const snap of page.Snapshots ?? []) {
        resources.push({ service: 'EC2', type: 'Snapshot', region, id: snap.SnapshotId! });
      }
    }
  } catch (e) { console.error(`warn: snapshots ${region}: ${e}`); }

  try {
    const result = await client.send(new DescribeAddressesCommand({}));
    for (const addr of result.Addresses ?? []) {
      resources.push({ service: 'EC2', type: 'ElasticIP', region, id: addr.AllocationId ?? addr.PublicIp! });
    }
  } catch (e) { console.error(`warn: elastic IPs ${region}: ${e}`); }

  try {
    const result = await client.send(new DescribeImagesCommand({ Owners: ['self'] }));
    for (const img of result.Images ?? []) {
      resources.push({ service: 'EC2', type: 'AMI', region, id: img.ImageId! });
    }
  } catch (e) { console.error(`warn: AMIs ${region}: ${e}`); }

  return resources;
}

async function listVPC(region: string, meta: CollectionMeta): Promise<Resource[]> {
  const client = new EC2Client({ region });
  const resources: Resource[] = [];
  const defaultVpcIds = new Set<string>();

  try {
    for await (const page of paginateDescribeVpcs({ client }, {})) {
      for (const vpc of page.Vpcs ?? []) {
        if (vpc.IsDefault) {
          defaultVpcIds.add(vpc.VpcId!);
          continue;
        }
        resources.push({ service: 'VPC', type: 'VPC', region, id: vpc.VpcId! });
      }
    }
  } catch (e) { console.error(`warn: VPCs ${region}: ${e}`); }

  try {
    for await (const page of paginateDescribeSubnets({ client }, {})) {
      for (const subnet of page.Subnets ?? []) {
        if (subnet.VpcId && defaultVpcIds.has(subnet.VpcId)) continue;
        resources.push({ service: 'VPC', type: 'Subnet', region, id: subnet.SubnetId! });
        if (subnet.VpcId) meta.subnetVpcIds.set(subnet.SubnetId!, subnet.VpcId);
      }
    }
  } catch (e) { console.error(`warn: subnets ${region}: ${e}`); }

  try {
    for await (const page of paginateDescribeInternetGateways({ client }, {})) {
      for (const igw of page.InternetGateways ?? []) {
        resources.push({ service: 'VPC', type: 'InternetGateway', region, id: igw.InternetGatewayId! });
        const vpcId = igw.Attachments?.[0]?.VpcId;
        if (vpcId) meta.igwVpcIds.set(igw.InternetGatewayId!, vpcId);
      }
    }
  } catch (e) { console.error(`warn: internet gateways ${region}: ${e}`); }

  try {
    for await (const page of paginateDescribeNatGateways({ client }, {})) {
      for (const ngw of page.NatGateways ?? []) {
        resources.push({ service: 'VPC', type: 'NatGateway', region, id: ngw.NatGatewayId! });
        if (ngw.SubnetId) meta.ngwSubnetIds.set(ngw.NatGatewayId!, ngw.SubnetId);
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
      resources.push({ service: 'S3', type: 'Bucket', region: 'global', id: bucket.Name! });
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
        resources.push({ service: 'IAM', type: 'User', region: 'global', id: user.Arn! });
      }
    }
  } catch (e) { console.error(`warn: IAM users: ${e}`); }

  try {
    for await (const page of paginateListRoles({ client }, {})) {
      for (const role of page.Roles ?? []) {
        resources.push({ service: 'IAM', type: 'Role', region: 'global', id: role.Arn! });
      }
    }
  } catch (e) { console.error(`warn: IAM roles: ${e}`); }

  try {
    for await (const page of paginateListGroups({ client }, {})) {
      for (const group of page.Groups ?? []) {
        resources.push({ service: 'IAM', type: 'Group', region: 'global', id: group.Arn! });
      }
    }
  } catch (e) { console.error(`warn: IAM groups: ${e}`); }

  try {
    for await (const page of paginateListPolicies({ client }, { Scope: PolicyScopeType.Local })) {
      for (const policy of page.Policies ?? []) {
        resources.push({ service: 'IAM', type: 'Policy', region: 'global', id: policy.Arn! });
      }
    }
  } catch (e) { console.error(`warn: IAM policies: ${e}`); }

  return resources;
}

async function listRDS(region: string, meta: CollectionMeta): Promise<Resource[]> {
  const client = new RDSClient({ region });
  const resources: Resource[] = [];

  try {
    for await (const page of paginateDescribeDBInstances({ client }, {})) {
      for (const db of page.DBInstances ?? []) {
        const id = db.DBInstanceIdentifier!;
        resources.push({ service: 'RDS', type: 'DBInstance', region, id });
        if (db.DBClusterIdentifier) meta.dbInstanceClusterIds.set(id, db.DBClusterIdentifier);
      }
    }
  } catch (e) { console.error(`warn: RDS instances ${region}: ${e}`); }

  try {
    for await (const page of paginateDescribeDBClusters({ client }, {})) {
      for (const cluster of page.DBClusters ?? []) {
        resources.push({ service: 'RDS', type: 'DBCluster', region, id: cluster.DBClusterIdentifier! });
      }
    }
  } catch (e) { console.error(`warn: RDS clusters ${region}: ${e}`); }

  return resources;
}

async function listLambda(region: string): Promise<Resource[]> {
  const client = new LambdaClient({ region });
  const resources: Resource[] = [];

  try {
    for await (const page of paginateListFunctions({ client }, {})) {
      for (const fn of page.Functions ?? []) {
        resources.push({ service: 'Lambda', type: 'Function', region, id: fn.FunctionArn! });
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
        resources.push({ service: 'DynamoDB', type: 'Table', region, id: tableName });
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
        resources.push({ service: 'CloudFormation', type: 'Stack', region, id: stack.StackId! });
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
        resources.push({ service: 'ECS', type: 'Cluster', region, id: arn });
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
        resources.push({ service: 'EKS', type: 'Cluster', region, id: name });
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
        resources.push({ service: 'SNS', type: 'Topic', region, id: topic.TopicArn! });
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
        resources.push({ service: 'SQS', type: 'Queue', region, id: url });
      }
    }
  } catch (e) { console.error(`warn: SQS ${region}: ${e}`); }

  return resources;
}

async function listCloudFront(): Promise<Resource[]> {
  const client = new CloudFrontClient({ region: 'us-east-1' });
  const resources: Resource[] = [];
  let marker: string | undefined;

  try {
    while (true) {
      const result = await client.send(new ListDistributionsCommand({ Marker: marker }));
      const list = result.DistributionList;
      if (!list) break;
      for (const dist of list.Items ?? []) {
        resources.push({ service: 'CloudFront', type: 'Distribution', region: 'global', id: dist.Id! });
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
        resources.push({ service: 'Route53', type: 'HostedZone', region: 'global', id: zone.Id! });
      }
    }
  } catch (e) { console.error(`warn: Route53: ${e}`); }

  return resources;
}

interface TreeNode {
  arn: string;
  children?: TreeNode[];
}

function buildTree(resources: Resource[], meta: CollectionMeta, accountId: string): TreeNode[] {
  // Map raw id -> computed ARN for parent lookups
  const arnById = new Map<string, string>();
  for (const r of resources) {
    arnById.set(r.id, toArn(r, accountId));
  }

  // Determine parent ARN for each resource
  const parentArnOf = new Map<string, string>();
  for (const r of resources) {
    const arn = toArn(r, accountId);
    let parentId: string | undefined;

    if (r.service === 'VPC' && r.type === 'Subnet') {
      parentId = meta.subnetVpcIds.get(r.id);
    } else if (r.service === 'VPC' && r.type === 'InternetGateway') {
      parentId = meta.igwVpcIds.get(r.id);
    } else if (r.service === 'VPC' && r.type === 'NatGateway') {
      parentId = meta.ngwSubnetIds.get(r.id);
    } else if (r.service === 'EC2' && r.type === 'SecurityGroup') {
      parentId = meta.sgVpcIds.get(r.id);
    } else if (r.service === 'EC2' && r.type === 'Volume') {
      parentId = meta.volumeInstanceIds.get(r.id);
    } else if (r.service === 'EC2' && r.type === 'Instance') {
      parentId = meta.instanceSubIds.get(r.id);
    } else if (r.service === 'RDS' && r.type === 'DBInstance') {
      parentId = meta.dbInstanceClusterIds.get(r.id);
    }

    if (parentId) {
      const parentArn = arnById.get(parentId);
      if (parentArn) parentArnOf.set(arn, parentArn);
    }
  }

  // Build tree nodes
  const nodes = new Map<string, TreeNode>();
  for (const r of resources) {
    const arn = toArn(r, accountId);
    nodes.set(arn, { arn });
  }

  const roots: TreeNode[] = [];
  for (const [arn, node] of nodes) {
    const parentArn = parentArnOf.get(arn);
    if (parentArn && nodes.has(parentArn)) {
      const parent = nodes.get(parentArn)!;
      if (!parent.children) parent.children = [];
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

function printJSON(tree: TreeNode[]): void {
  console.log(JSON.stringify(tree, null, 2));
}

async function main(): Promise<void> {
  console.error('Resolving account and regions...');
  const [accountId, regions] = await Promise.all([getAccountId(), getRegions()]);
  console.error(`Account: ${accountId} — scanning ${regions.length} regions across 14 services...`);

  const meta = newMeta();
  const allResources: Resource[] = [];

  const globalResults = await Promise.all([
    listS3(),
    listIAM(),
    listCloudFront(),
    listRoute53(),
  ]);
  for (const r of globalResults) allResources.push(...r);

  const regionalResults = await Promise.all(
    regions.map(region =>
      Promise.all([
        listEC2(region, meta),
        listVPC(region, meta),
        listRDS(region, meta),
        listLambda(region),
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

  const tree = buildTree(allResources, meta, accountId);
  printJSON(tree);
  console.error(`\nTotal: ${allResources.length} resources found`);
}

main().catch(e => {
  console.error(`Fatal: ${e}`);
  process.exit(1);
});
