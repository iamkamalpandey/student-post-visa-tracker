import { z } from 'zod';
import { CountryAlpha2, Iso8601Date, PaginationQuery, Uuid } from './common.js';

export const AddressTypeEnum = z.enum(['PERMANENT', 'CURRENT', 'DESTINATION', 'CORRESPONDENCE']);
export type AddressType = z.infer<typeof AddressTypeEnum>;

export const CreateAddressRequest = z
  .object({
    line1: z.string().min(1).max(200),
    line2: z.string().max(200).optional(),
    line3: z.string().max(200).optional(),
    locality: z.string().min(1).max(120),
    region: z.string().max(120).optional(),
    postal_code: z.string().max(20).optional(),
    country_code: CountryAlpha2,
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    formatted: z.string().max(500).optional(),
  })
  .strict();
export type CreateAddressRequest = z.infer<typeof CreateAddressRequest>;

export const UpdateAddressRequest = CreateAddressRequest.partial().strict();
export type UpdateAddressRequest = z.infer<typeof UpdateAddressRequest>;

export const AddressListQuery = PaginationQuery.extend({
  country_code: CountryAlpha2.optional(),
}).strict();
export type AddressListQuery = z.infer<typeof AddressListQuery>;

// StudentAddress: link an existing address to a student.
export const CreateStudentAddressRequest = z
  .object({
    address_id: Uuid,
    type: AddressTypeEnum,
    is_current: z.boolean().default(false),
    valid_from: Iso8601Date.optional(),
    valid_to: Iso8601Date.optional(),
  })
  .strict();
export type CreateStudentAddressRequest = z.infer<typeof CreateStudentAddressRequest>;

export const UpdateStudentAddressRequest = CreateStudentAddressRequest.partial().strict();
export type UpdateStudentAddressRequest = z.infer<typeof UpdateStudentAddressRequest>;
