import { z } from 'zod';
import { CurrencyCode, E164Phone, Email, PaginationQuery, Uuid } from './common.js';

const Money = z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]);

export const CreateContactRequest = z
  .object({
    relationship_id: Uuid,
    given_name: z.string().min(1).max(120),
    family_name: z.string().min(1).max(120),
    phone_e164: E164Phone.optional(),
    email: Email.optional(),
    occupation: z.string().max(120).optional(),
    employer: z.string().max(200).optional(),
    annual_income_minor: Money.optional(),
    income_currency: CurrencyCode.optional(),
    is_primary_guardian: z.boolean().default(false),
    is_emergency_contact: z.boolean().default(false),
    is_financial_sponsor: z.boolean().default(false),
    address_id: Uuid.optional(),
  })
  .strict();
export type CreateContactRequest = z.infer<typeof CreateContactRequest>;

export const UpdateContactRequest = CreateContactRequest.partial().strict();
export type UpdateContactRequest = z.infer<typeof UpdateContactRequest>;

export const ContactListQuery = PaginationQuery.strict();
export type ContactListQuery = z.infer<typeof ContactListQuery>;
