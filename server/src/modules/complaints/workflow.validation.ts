/**
 * Request schemas for the workflow transitions.
 */
import { z } from 'zod';
import { CUSTOMER_AVAILABILITY, RESOLUTION_REVIEW_OUTCOMES } from '../../models/enums.js';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Not a valid identifier');

/** A reason that is actually a reason, not a space bar press. */
const reason = z
  .string()
  .trim()
  .min(3, 'Please give a reason of at least 3 characters')
  .max(2000);

export const assignServiceCenterSchema = z.object({
  serviceCenterId: objectId,
  /* Required by the status machine when this is a *re*assignment; harmless
     on a first assignment, so it is optional here and enforced there. */
  reason: reason.optional(),
});

export const assignTechnicianSchema = z.object({
  technicianId: objectId,
  reason: reason.optional(),
});

export const scheduleVisitSchema = z.object({
  scheduledAt: z.coerce.date(),
  /* Lets an Owner schedule and (re)assign in one action. */
  technicianId: objectId.optional(),
  reason: reason.optional(),
  notes: z.string().trim().max(1000).optional(),
});

export const rescheduleVisitSchema = z.object({
  scheduledAt: z.coerce.date(),
  reason,
});

export const startVisitSchema = z
  .object({
    customerAvailability: z.enum(CUSTOMER_AVAILABILITY).optional(),
    availabilityNote: z.string().trim().max(1000).optional(),
    /**
     * Whether the trip ends here with no work done. Leave it out and the
     * availability decides (see `endsOnArrival`); send it for the cases in
     * between — a neighbour with the key, a power cut on the street.
     */
    endVisit: z.boolean().optional(),
  })
  .refine(
    (data) =>
      data.endVisit !== true ||
      (data.customerAvailability !== undefined &&
        data.customerAvailability !== 'CUSTOMER_AVAILABLE'),
    {
      path: ['endVisit'],
      message: 'Record what stopped the work before ending the visit',
    },
  );

export const submitResolutionSchema = z.object({
  diagnosis: z.object({
    problemFound: z.string().trim().min(1, 'What was the problem?').max(2000),
    notes: z.string().trim().max(5000).optional(),
  }),
  workPerformed: z.object({
    details: z.string().trim().min(1, 'What work was done?').max(5000),
    remarks: z.string().trim().max(2000).optional(),
  }),
  resolution: z.object({
    result: z.string().trim().min(1, 'What is the outcome?').max(2000),
    remarks: z.string().trim().max(2000).optional(),
    customerFeedback: z.string().trim().max(2000).optional(),
  }),
  customerAvailability: z.enum(CUSTOMER_AVAILABILITY).optional(),
  happyCode: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'The Happy Code is 6 digits')
    .optional(),
});

export const reviewResolutionSchema = z
  .object({
    outcome: z.enum(RESOLUTION_REVIEW_OUTCOMES),
    reason: z.string().trim().max(2000).optional(),
  })
  /* Workflow E step 4: "Reason is mandatory" when sending it back. The status
     machine enforces this too; catching it here gives a field-level error the
     form can attach to the right input. */
  .refine(
    (data) => data.outcome !== 'REVISIT_REQUIRED' || (data.reason?.length ?? 0) >= 3,
    {
      path: ['reason'],
      message: 'A reason is required when requiring a revisit',
    },
  );

export const verifyHappyCodeSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'The Happy Code is 6 digits'),
});

export const reasonOnlySchema = z.object({ reason });

export const waitingForPartsSchema = z.object({
  reason,
});

/**
 * Admin's rating of the service centre's work on a closed complaint
 * (DECISIONS.md section 31).
 *
 * `note` follows the explicit-clear convention already used for a user's
 * email (`users.validation.ts`): the whole rating is resubmitted every time,
 * so a note left out — or emptied — of a *change* means "remove it", not
 * "leave the old one".
 */
export const rateServiceSchema = z.object({
  stars: z.coerce
    .number()
    .int('A rating is a whole number of stars')
    .min(1, 'Choose 1 to 5 stars')
    .max(5, 'Choose 1 to 5 stars'),
  note: z.string().trim().max(1000, 'Keep the note under 1000 characters').optional(),
});

export const closeComplaintSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'The Happy Code is 6 digits')
    .optional(),
  remarks: z
    .string()
    .trim()
    .max(2000, 'Keep remarks under 2000 characters')
    .optional(),
});

export type CloseComplaintInput = z.infer<typeof closeComplaintSchema>;
export type AssignServiceCenterInput = z.infer<typeof assignServiceCenterSchema>;
export type AssignTechnicianInput = z.infer<typeof assignTechnicianSchema>;
export type ScheduleVisitInput = z.infer<typeof scheduleVisitSchema>;
export type RescheduleVisitInput = z.infer<typeof rescheduleVisitSchema>;
export type StartVisitInput = z.infer<typeof startVisitSchema>;
export type SubmitResolutionInput = z.infer<typeof submitResolutionSchema>;
export type ReviewResolutionInput = z.infer<typeof reviewResolutionSchema>;
export type VerifyHappyCodeInput = z.infer<typeof verifyHappyCodeSchema>;
export type ReasonOnlyInput = z.infer<typeof reasonOnlySchema>;
export type RateServiceInput = z.infer<typeof rateServiceSchema>;
