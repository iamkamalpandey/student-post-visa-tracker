import { z } from 'zod';
import { CurrencyCode, Iso8601DateTime, PaginationQuery } from './common.js';

export const TravelStatusEnum = z.enum(['PLANNED', 'BOOKED', 'CANCELLED', 'COMPLETED']);
export type TravelStatus = z.infer<typeof TravelStatusEnum>;

const IataAirline = z.string().length(2).regex(/^[A-Z0-9]{2}$/, 'IATA airline (2 chars)');
const IataAirport = z.string().length(3).regex(/^[A-Z]{3}$/, 'IATA airport (3 chars)');

export const CreateTravelRequest = z
  .object({
    pnr: z.string().min(1).max(40).optional(),
    airline_iata: IataAirline.optional(),
    flight_number: z.string().min(1).max(20).optional(),
    departure_iata: IataAirport.optional(),
    arrival_iata: IataAirport.optional(),
    departure_at: Iso8601DateTime.optional(),
    arrival_at: Iso8601DateTime.optional(),
    pickup_arranged: z.boolean().default(false),
    pickup_notes: z.string().max(2000).optional(),
    fare_minor: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]).optional(),
    fare_currency: CurrencyCode.optional(),
    status: TravelStatusEnum.default('BOOKED'),
  })
  .strict();
export type CreateTravelRequest = z.infer<typeof CreateTravelRequest>;

export const UpdateTravelRequest = CreateTravelRequest.partial().strict();
export type UpdateTravelRequest = z.infer<typeof UpdateTravelRequest>;

export const TravelListQuery = PaginationQuery.extend({
  status: TravelStatusEnum.optional(),
}).strict();
export type TravelListQuery = z.infer<typeof TravelListQuery>;
