import { z } from 'zod';

export const packageKinds = ['connector', 'capability', 'core'] as const;
export const packageStatuses = ['stable', 'beta', 'planned'] as const;

const metadataSchema = z
  .strictObject({
    kind: z.enum(packageKinds),
    status: z.enum(packageStatuses),
    facade: z
      .string()
      .regex(/^[a-z][a-z-]*$/, 'bro.facade must be a facade identifier')
      .optional(),
  })
  .refine(row => row.kind !== 'connector' || row.facade !== undefined, {
    message: 'connector requires bro.facade',
  });

export type BroMetadata = z.infer<typeof metadataSchema>;

export function validateBroMetadata(value: unknown): BroMetadata {
  return metadataSchema.parse(value);
}
