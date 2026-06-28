export const QUEUES = {
  COLLECT: 'collect',
  RISK_CHECK: 'risk-check',
  SCORE: 'score',
  SNAPSHOT: 'snapshot',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];
