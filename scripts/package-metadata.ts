export const packageKinds = ['connector', 'capability', 'core'] as const;
export const packageStatuses = ['stable', 'beta', 'planned'] as const;

export interface BroMetadata {
  kind: (typeof packageKinds)[number];
  status: (typeof packageStatuses)[number];
  facade?: string;
}

export function validateBroMetadata(value: unknown): BroMetadata {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('bro must be an object');
  }
  const row = value as Record<string, unknown>;
  if (!packageKinds.some(kind => kind === row.kind)) throw new Error('invalid bro.kind');
  if (!packageStatuses.some(status => status === row.status)) throw new Error('invalid bro.status');
  if (Object.keys(row).some(key => !['kind', 'status', 'facade'].includes(key))) {
    throw new Error('unknown bro metadata field');
  }
  if (
    row.facade !== undefined &&
    (typeof row.facade !== 'string' || !/^[a-z][a-z-]*$/.test(row.facade))
  ) {
    throw new Error('bro.facade must be a facade identifier');
  }
  if (row.kind === 'connector' && !row.facade) throw new Error('connector requires bro.facade');
  return row as unknown as BroMetadata;
}
