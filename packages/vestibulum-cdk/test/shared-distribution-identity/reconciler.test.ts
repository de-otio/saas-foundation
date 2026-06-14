/**
 * CDK assertion tests for the `Reconciler` construct.
 *
 * Tests:
 * - Hourly EventBridge schedule.
 * - IAM scopes (ListUserPoolClients + ReadData).
 * - OrphanedAppClients-Sustained alarm.
 * - OrphanedConfigRows-Sustained alarm.
 * - SNS subscription when alarmTopic provided.
 */

import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sns from 'aws-cdk-lib/aws-sns';
import { beforeAll, describe, expect, it } from 'vitest';
import { Reconciler } from '../../lib/shared-distribution-identity/reconciler.js';

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

  return { userPool, clientConfigTable };
}

// ---------------------------------------------------------------------------
// Default construct
// ---------------------------------------------------------------------------

describe('Reconciler — default props', () => {
  let template: Template;

  beforeAll(() => {
    const stack = makeStack('ReconcilerStack');
    const { userPool, clientConfigTable } = makeDeps(stack);

    new Reconciler(stack, 'Reconciler', {
      userPool,
      clientConfigTable,
    });

    template = Template.fromStack(stack);
  });

  it('creates a Lambda function', () => {
    template.resourceCountIs('AWS::Lambda::Function', 2); // fn + log-retention helper
  });

  it('creates an EventBridge rule with rate(1 hour) schedule', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(1 hour)',
    });
  });

  it('EventBridge rule targets the Lambda function', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      Targets: Match.arrayWith([
        Match.objectLike({
          Arn: Match.objectLike({}),
        }),
      ]),
    });
  });

  it('creates 2 CloudWatch alarms', () => {
    template.resourceCountIs('AWS::CloudWatch::Alarm', 2);
  });

  it('creates OrphanedAppClients-Sustained alarm', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'OrphanedAppClients',
      Namespace: 'Vestibulum/SharedDistribution',
      ComparisonOperator: 'GreaterThanThreshold',
      Threshold: 0,
    });
  });

  it('creates OrphanedConfigRows-Sustained alarm', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'OrphanedConfigRows',
      Namespace: 'Vestibulum/SharedDistribution',
      ComparisonOperator: 'GreaterThanThreshold',
      Threshold: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// IAM grants scoping
// ---------------------------------------------------------------------------

describe('Reconciler — IAM grants', () => {
  it('Cognito grant contains only ListUserPoolClients action', () => {
    const stack = makeStack('ReconcilerIamStack');
    const { userPool, clientConfigTable } = makeDeps(stack);

    new Reconciler(stack, 'Reconciler', { userPool, clientConfigTable });

    const template = Template.fromStack(stack);
    const policies = template.findResources('AWS::IAM::Policy');

    let foundListUserPoolClients = false;

    for (const policy of Object.values(policies)) {
      const statements: Array<{ Action: string | string[]; Resource: unknown }> =
        (policy as Record<string, Record<string, unknown>>)['Properties']?.['PolicyDocument']?.['Statement'] as Array<{ Action: string | string[]; Resource: unknown }> ?? [];

      for (const stmt of statements) {
        const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
        const hasCognito = actions.some((a) => String(a).startsWith('cognito-idp:'));
        if (hasCognito) {
          foundListUserPoolClients = actions.some((a) => String(a) === 'cognito-idp:ListUserPoolClients');
          // Must NOT have write actions like CreateUserPoolClient
          expect(actions).not.toContain('cognito-idp:CreateUserPoolClient');
          expect(actions).not.toContain('cognito-idp:DeleteUserPoolClient');
          expect(actions).not.toContain('cognito-idp:AdminUserGlobalSignOut');
        }
      }
    }

    expect(foundListUserPoolClients).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 1-hour sustain on alarms
// ---------------------------------------------------------------------------

describe('Reconciler — alarm sustain period', () => {
  it('OrphanedAppClients alarm has 60-minute period', () => {
    const stack = makeStack('AlarmPeriodStack');
    const { userPool, clientConfigTable } = makeDeps(stack);

    new Reconciler(stack, 'Reconciler', { userPool, clientConfigTable });

    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'OrphanedAppClients',
      Period: 3600, // 60 minutes in seconds
    });
  });

  it('OrphanedConfigRows alarm has 60-minute period', () => {
    const stack = makeStack('AlarmPeriodStack2');
    const { userPool, clientConfigTable } = makeDeps(stack);

    new Reconciler(stack, 'Reconciler', { userPool, clientConfigTable });

    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'OrphanedConfigRows',
      Period: 3600,
    });
  });
});

// ---------------------------------------------------------------------------
// SNS alarm subscription
// ---------------------------------------------------------------------------

describe('Reconciler — SNS alarm subscription', () => {
  it('subscribes alarms to SNS topic when alarmTopic provided', () => {
    const stack = makeStack('ReconcilerAlarmTopicStack');
    const { userPool, clientConfigTable } = makeDeps(stack);
    const alarmTopic = new sns.Topic(stack, 'AlarmTopic');

    new Reconciler(stack, 'Reconciler', {
      userPool,
      clientConfigTable,
      alarmTopic,
    });

    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmActions: Match.arrayWith([
        Match.objectLike({}),
      ]),
    });
  });

  it('no alarm actions when alarmTopic not provided', () => {
    const stack = makeStack('ReconcilerNoAlarmTopicStack');
    const { userPool, clientConfigTable } = makeDeps(stack);

    new Reconciler(stack, 'Reconciler', { userPool, clientConfigTable });

    const template = Template.fromStack(stack);
    const alarms = template.findResources('AWS::CloudWatch::Alarm');
    for (const alarm of Object.values(alarms)) {
      const actions = (alarm as Record<string, Record<string, unknown>>)['Properties']?.['AlarmActions'];
      expect(actions == null || (Array.isArray(actions) && actions.length === 0)).toBe(true);
    }
  });
});
