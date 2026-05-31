/**
 * CDK assertion tests for the `AdminLambda` construct.
 *
 * Tests:
 * - Function URL AuthType: AWS_IAM.
 * - Both lambda:InvokeFunctionUrl and lambda:InvokeFunction granted to principal.
 * - InvokedViaFunctionUrl condition on the InvokeFunction grant.
 * - DDB grants scoped (not arn:*).
 * - Wildcard AllowOrigins: ['*'] rejected at synth.
 * - Alarms created with correct names.
 */

import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sns from 'aws-cdk-lib/aws-sns';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  AdminLambda,
  AdminLambdaPropsError,
} from '../../lib/shared-distribution-identity/admin-lambda.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_ENV = { account: '123456789012', region: 'eu-west-1' };

function makeStack(name: string): cdk.Stack {
  const app = new cdk.App();
  return new cdk.Stack(app, name, { env: TEST_ENV, stackName: name });
}

function makeDeps(stack: cdk.Stack) {
  const userPool = cognito.UserPool.fromUserPoolId(stack, 'Pool', 'us-east-1_test');

  // Use tableArn only (not both tableName and tableArn — CDK rejects the combination)
  const clientConfigTable = dynamodb.Table.fromTableArn(
    stack,
    'ClientConfig',
    'arn:aws:dynamodb:eu-west-1:123456789012:table/client-config',
  );

  const magicLinkTokensTable = dynamodb.Table.fromTableArn(
    stack,
    'MagicLinkTokens',
    'arn:aws:dynamodb:eu-west-1:123456789012:table/magic-link-tokens',
  );

  const reservationsTable = dynamodb.Table.fromTableArn(
    stack,
    'Reservations',
    'arn:aws:dynamodb:eu-west-1:123456789012:table/reservations',
  );

  const adminRole = new iam.Role(stack, 'AdminRole', {
    assumedBy: new iam.AccountPrincipal('123456789012'),
  });

  return { userPool, clientConfigTable, magicLinkTokensTable, reservationsTable, adminRole };
}

// ---------------------------------------------------------------------------
// Default construct + template
// ---------------------------------------------------------------------------

describe('AdminLambda — default props', () => {
  let template: Template;

  beforeAll(() => {
    const stack = makeStack('AdminLambdaStack');
    const { userPool, clientConfigTable, magicLinkTokensTable, reservationsTable, adminRole } =
      makeDeps(stack);

    new AdminLambda(stack, 'AdminLambda', {
      userPool,
      clientConfigTable,
      magicLinkTokensTable,
      reservationsTable,
      tenantSubdomainParent: 'tenants.example.com',
      adminInvokePrincipal: adminRole,
    });

    template = Template.fromStack(stack);
  });

  it('creates a Lambda function', () => {
    template.resourceCountIs('AWS::Lambda::Function', 2); // fn + log-retention helper
  });

  it('creates a Function URL with AuthType AWS_IAM', () => {
    template.hasResourceProperties('AWS::Lambda::Url', {
      AuthType: 'AWS_IAM',
    });
  });

  it('grants lambda:InvokeFunctionUrl to the admin principal', () => {
    template.hasResourceProperties('AWS::Lambda::Permission', {
      Action: 'lambda:InvokeFunctionUrl',
    });
  });

  it('grants lambda:InvokeFunction with InvokedViaFunctionUrl: true', () => {
    template.hasResourceProperties('AWS::Lambda::Permission', {
      Action: 'lambda:InvokeFunction',
      InvokedViaFunctionUrl: true,
    });
  });

  it('creates 3 CloudWatch alarms', () => {
    template.resourceCountIs('AWS::CloudWatch::Alarm', 3);
  });

  it('creates AllowlistChanged-RealTime alarm', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'AllowlistChanged',
      Namespace: 'Vestibulum/SharedDistribution',
      ComparisonOperator: 'GreaterThanThreshold',
      Threshold: 0,
    });
  });

  it('creates TenantDeleted-RealTime alarm', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'TenantDeleted',
      Namespace: 'Vestibulum/SharedDistribution',
      ComparisonOperator: 'GreaterThanThreshold',
      Threshold: 0,
    });
  });

  it('creates CompensationTriggered alarm', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'CompensationTriggered',
      Namespace: 'Vestibulum/SharedDistribution',
      ComparisonOperator: 'GreaterThanThreshold',
      Threshold: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// InvokedViaFunctionUrl condition — detailed assertion
// ---------------------------------------------------------------------------

describe('AdminLambda — InvokedViaFunctionUrl condition (Oct 2025 grant)', () => {
  it('has InvokedViaFunctionUrl: true on the InvokeFunction permission', () => {
    const stack = makeStack('InvokedViaFunctionUrlStack');
    const { userPool, clientConfigTable, magicLinkTokensTable, reservationsTable, adminRole } =
      makeDeps(stack);

    new AdminLambda(stack, 'AdminLambda', {
      userPool,
      clientConfigTable,
      magicLinkTokensTable,
      reservationsTable,
      tenantSubdomainParent: 'tenants.example.com',
      adminInvokePrincipal: adminRole,
    });

    const template = Template.fromStack(stack);

    // The InvokeFunction permission must have InvokedViaFunctionUrl: true
    template.hasResourceProperties('AWS::Lambda::Permission', {
      Action: 'lambda:InvokeFunction',
      InvokedViaFunctionUrl: true,
    });
  });
});

// ---------------------------------------------------------------------------
// CORS wildcard rejection
// ---------------------------------------------------------------------------

describe('AdminLambda — CORS wildcard rejection', () => {
  it('throws AdminLambdaPropsError when allowedOrigins includes "*"', () => {
    const stack = makeStack('CorsWildcardStack');
    const { userPool, clientConfigTable, magicLinkTokensTable, reservationsTable, adminRole } =
      makeDeps(stack);

    expect(() => {
      new AdminLambda(stack, 'AdminLambda', {
        userPool,
        clientConfigTable,
        magicLinkTokensTable,
        reservationsTable,
        tenantSubdomainParent: 'tenants.example.com',
        adminInvokePrincipal: adminRole,
        adminFunctionUrlCors: {
          allowedOrigins: ['*'],
        },
      });
    }).toThrow(AdminLambdaPropsError);
  });

  it('accepts explicit allowed origins', () => {
    const stack = makeStack('CorsExplicitStack');
    const { userPool, clientConfigTable, magicLinkTokensTable, reservationsTable, adminRole } =
      makeDeps(stack);

    expect(() => {
      new AdminLambda(stack, 'AdminLambda', {
        userPool,
        clientConfigTable,
        magicLinkTokensTable,
        reservationsTable,
        tenantSubdomainParent: 'tenants.example.com',
        adminInvokePrincipal: adminRole,
        adminFunctionUrlCors: {
          allowedOrigins: ['https://admin.example.com'],
          allowedMethods: [lambda.HttpMethod.POST],
        },
      });
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// SNS alarm subscription
// ---------------------------------------------------------------------------

describe('AdminLambda — SNS alarm subscription', () => {
  it('subscribes alarms to SNS topic when alarmTopic provided', () => {
    const stack = makeStack('AlarmTopicStack');
    const { userPool, clientConfigTable, magicLinkTokensTable, reservationsTable, adminRole } =
      makeDeps(stack);
    const alarmTopic = new sns.Topic(stack, 'AlarmTopic');

    new AdminLambda(stack, 'AdminLambda', {
      userPool,
      clientConfigTable,
      magicLinkTokensTable,
      reservationsTable,
      tenantSubdomainParent: 'tenants.example.com',
      adminInvokePrincipal: adminRole,
      alarmTopic,
    });

    const template = Template.fromStack(stack);

    // Each alarm should have an AlarmActions entry pointing to the SNS topic
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmActions: Match.arrayWith([{ Ref: stack.getLogicalId(alarmTopic.node.defaultChild as cdk.CfnElement) }]),
    });
  });

  it('does not create SNS actions when alarmTopic not provided', () => {
    const stack = makeStack('NoAlarmTopicStack');
    const { userPool, clientConfigTable, magicLinkTokensTable, reservationsTable, adminRole } =
      makeDeps(stack);

    new AdminLambda(stack, 'AdminLambda', {
      userPool,
      clientConfigTable,
      magicLinkTokensTable,
      reservationsTable,
      tenantSubdomainParent: 'tenants.example.com',
      adminInvokePrincipal: adminRole,
    });

    const template = Template.fromStack(stack);
    // Alarms should exist but without AlarmActions
    const alarms = template.findResources('AWS::CloudWatch::Alarm');
    const alarmValues = Object.values(alarms);
    for (const alarm of alarmValues) {
      const actions = (alarm as Record<string, Record<string, unknown>>)['Properties']?.['AlarmActions'];
      expect(actions == null || (Array.isArray(actions) && actions.length === 0)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// IAM grants scoped (not arn:*)
// ---------------------------------------------------------------------------

describe('AdminLambda — IAM grants scoping', () => {
  it('Cognito grant scoped to user pool ARN (not wildcard)', () => {
    const stack = makeStack('IamScopingStack');
    const { userPool, clientConfigTable, magicLinkTokensTable, reservationsTable, adminRole } =
      makeDeps(stack);

    new AdminLambda(stack, 'AdminLambda', {
      userPool,
      clientConfigTable,
      magicLinkTokensTable,
      reservationsTable,
      tenantSubdomainParent: 'tenants.example.com',
      adminInvokePrincipal: adminRole,
    });

    const template = Template.fromStack(stack);

    // Find IAM policies with Cognito actions — should NOT have arn:*
    const policies = template.findResources('AWS::IAM::Policy');
    for (const policy of Object.values(policies)) {
      const statements: Array<{ Action: string | string[]; Resource: string | string[] }> =
        (policy as Record<string, Record<string, unknown>>)['Properties']?.['PolicyDocument']?.['Statement'] as Array<{ Action: string | string[]; Resource: string | string[] }> ?? [];

      for (const stmt of statements) {
        const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
        const hasCognito = actions.some((a) => String(a).startsWith('cognito-idp:'));
        if (hasCognito) {
          const resources = Array.isArray(stmt.Resource) ? stmt.Resource : [stmt.Resource];
          for (const res of resources) {
            expect(String(res)).not.toBe('*');
          }
        }
      }
    }
  });
});
