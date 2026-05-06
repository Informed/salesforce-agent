import {
  AgentCoreApplication,
  AgentCoreMcp,
  type AgentCoreProjectSpec,
  type AgentCoreMcpSpec,
} from '@aws/agentcore-cdk';
import { CfnOutput, RemovalPolicy, SecretValue, Stack, type StackProps } from 'aws-cdk-lib';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface HarnessConfig {
  name: string;
  executionRoleArn?: string;
  memoryName?: string;
  containerUri?: string;
  hasDockerfile?: boolean;
  dockerfile?: string;
  codeLocation?: string;
  tools?: { type: string; name: string }[];
  apiKeyArn?: string;
}

export interface AgentCoreStackProps extends StackProps {
  /**
   * The AgentCore project specification containing agents, memories, and credentials.
   */
  spec: AgentCoreProjectSpec;
  /**
   * The MCP specification containing gateways and servers.
   */
  mcpSpec?: AgentCoreMcpSpec;
  /**
   * Credential provider ARNs from deployed state, keyed by credential name.
   */
  credentials?: Record<string, { credentialProviderArn: string; clientSecretArn?: string }>;
  /**
   * Harness role configurations. Each entry creates an IAM execution role for a harness.
   *
   * When `hasDockerfile` is true and `codeLocation` is provided (without an explicit
   * `containerUri`), the L3 construct builds and pushes a container image via CodeBuild
   * and emits its URI as a stack output for the post-CDK harness deployer.
   */
  harnesses?: HarnessConfig[];
  /**
   * When true (default) and `harnesses` is non-empty, create a Secrets Manager secret with
   * placeholder `SF_*` JSON and grant each harness execution role `GetSecretValue` (and
   * `DescribeSecret`). Set to false if you use another secret or inline PEM only.
   */
  createSalesforceJwtPlaceholderSecret?: boolean;
}

/**
 * CDK Stack that deploys AgentCore infrastructure.
 *
 * This is a thin wrapper that instantiates L3 constructs.
 * All resource logic and outputs are contained within the L3 constructs.
 */
export class AgentCoreStack extends Stack {
  /** The AgentCore application containing all agent environments */
  public readonly application: AgentCoreApplication;

  constructor(scope: Construct, id: string, props: AgentCoreStackProps) {
    super(scope, id, props);

    const { spec, mcpSpec, credentials, harnesses } = props;
    const createJwtPlaceholder =
      props.createSalesforceJwtPlaceholderSecret !== false && (harnesses?.length ?? 0) > 0;

    // Create AgentCoreApplication with all agents and harness roles
    this.application = new AgentCoreApplication(this, 'Application', {
      spec,
      harnesses: harnesses?.length ? harnesses : undefined,
    });

    if (createJwtPlaceholder && harnesses?.length) {
      const secret = new secretsmanager.Secret(this, 'SalesforceJwtPlaceholder', {
        description: `Placeholder Salesforce JWT JSON for ${spec.name} harness (sf-query / Secrets Manager). Replace values in the console or PutSecretValue.`,
        removalPolicy: RemovalPolicy.RETAIN,
        secretObjectValue: {
          SF_LOGIN_URL: SecretValue.unsafePlainText('https://login.salesforce.com'),
          SF_CLIENT_ID: SecretValue.unsafePlainText('REPLACE_ME'),
          SF_USERNAME: SecretValue.unsafePlainText('REPLACE_ME'),
          SF_PRIVATE_KEY_BODY: SecretValue.unsafePlainText('REPLACE_ME'),
        },
      });
      for (const h of harnesses) {
        const harnessRole = this.application.harnessRoles.get(h.name);
        if (harnessRole) {
          secret.grantRead(harnessRole.role);
        }
      }
      new CfnOutput(this, 'SalesforceJwtSecretArn', {
        description:
          'Secrets Manager ARN for placeholder Salesforce JWT — set SF_SECRET_ID in .env.harness, replace secret value with real SF_* JSON, then merge-harness-env and push-harness-env.',
        value: secret.secretArn,
      });
    }

    // Create AgentCoreMcp if there are gateways configured
    if (mcpSpec?.agentCoreGateways && mcpSpec.agentCoreGateways.length > 0) {
      new AgentCoreMcp(this, 'Mcp', {
        projectName: spec.name,
        mcpSpec,
        agentCoreApplication: this.application,
        credentials,
        projectTags: spec.tags,
      });
    }

    // Stack-level output
    new CfnOutput(this, 'StackNameOutput', {
      description: 'Name of the CloudFormation Stack',
      value: this.stackName,
    });
  }
}
