# AgentCore CDK Project

This CDK project is managed by the AgentCore CLI. It deploys your agent infrastructure into AWS using the `@aws/agentcore-cdk` L3 constructs.

## Structure

- `bin/cdk.ts` — Entry point. Reads project configuration from `agentcore/` and creates a stack per deployment target.
- `lib/cdk-stack.ts` — Defines `AgentCoreStack`, which wraps the `AgentCoreApplication` L3 construct.
- `test/cdk.test.ts` — Unit tests for stack synthesis.

## Useful commands

- `npm run build` compile TypeScript to JavaScript
- `npm run test` run unit tests
- `npx cdk synth` emit the synthesized CloudFormation template
- `npx cdk deploy` deploy this stack to your default AWS account/region
- `npx cdk diff` compare deployed stack with current state

## Salesforce JWT placeholder secret

When the project defines **at least one harness**, `AgentCoreStack` creates an **`AWS::SecretsManager::Secret`** with placeholder `SF_*` fields (`REPLACE_ME`) and grants **each harness execution role** `GetSecretValue` and `DescribeSecret` on it. The secret uses **removal policy RETAIN** so deleting the stack does not delete the secret by default.

After **`agentcore deploy`**, copy the CloudFormation output **`SalesforceJwtSecretArn`** into **`.env.harness`** as **`SF_SECRET_ID`**, replace the secret’s value with real JWT JSON (see repo `docs/agentcore-harness.md`), then run **`npm run merge-harness-env`** from the **salesforce-agent** repo root and **`npm run push-harness-env`**.

To **skip** creating this secret, add to **`agentcore.json`** (sibling of `harnesses`):

```json
"salesforceJwtSecret": { "skipPlaceholderSecret": true }
```

## Usage

You typically don't need to interact with this directory directly. The AgentCore CLI handles synthesis and deployment:

```bash
agentcore deploy    # synthesizes and deploys via CDK
agentcore status    # checks deployment status
```
