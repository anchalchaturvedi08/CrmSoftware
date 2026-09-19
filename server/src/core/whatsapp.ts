/**
 * WhatsApp deep link (spec sections 6.4, 15).
 *
 * Section 15 is unambiguous about scope: **no WhatsApp API in the MVP**, no
 * automated messages, no delivery tracking. This builds a `wa.me` URL that
 * opens WhatsApp with the message pre-typed. A human then presses send.
 *
 * Two consequences the rest of the system must respect:
 *
 *  - **Never claim delivery.** Section 6.4: "Never claim that the message was
 *    delivered/read." We cannot know. The response says a link was opened,
 *    nothing more.
 *  - **A bad number disables the action** rather than failing silently, and
 *    the reason is returned so Admin can correct the number (section 6.4,
 *    section 22 "Invalid customer phone").
 *
 * The message carries the Happy Code, which is the only route it has to the
 * customer — so the caller must have just decrypted it, and must record the
 * view in the audit log.
 */
import { normalizeMobile } from '../models/common/base.js';

/** India. The customer base is domestic; no other country code is issued. */
const COUNTRY_CODE = '91';

export interface WhatsAppMessageInput {
  customerName: string;
  customerMobile: string;
  complaintNumber: string;
  productName: string;
  modelNumber: string;
  happyCode: string;
  serviceCenterName?: string | undefined;
}

export type WhatsAppLink =
  | { available: true; url: string; message: string }
  | { available: false; reason: string };

/**
 * Composes the message body.
 *
 * Deliberately plain: it is read on a phone by someone who did not ask for it,
 * so it leads with what it is about and states exactly what the code is for.
 */
export function composeMessage(input: WhatsAppMessageInput): string {
  const lines = [
    `Hello ${input.customerName},`,
    '',
    `Your service request has been registered.`,
    '',
    `Complaint number: ${input.complaintNumber}`,
    `Product: ${input.productName} (${input.modelNumber})`,
  ];

  if (input.serviceCenterName) {
    lines.push(`Service centre: ${input.serviceCenterName}`);
  }

  lines.push(
    '',
    `Your confirmation code is ${input.happyCode}.`,
    'Please share this code with us only after the service is complete,',
    'so we can close your complaint.',
  );

  return lines.join('\n');
}

/**
 * Builds the deep link, or explains why it is unavailable.
 *
 * Returning a reason rather than throwing is what lets the complaint detail
 * page render a disabled button with an explanation — the behaviour section
 * 6.4 asks for. The complaint itself is unaffected either way; section 22 is
 * explicit that "WhatsApp is only a helper" and the workflow continues
 * normally without it.
 */
export function buildWhatsAppLink(input: WhatsAppMessageInput): WhatsAppLink {
  const digits = normalizeMobile(input.customerMobile ?? '');

  if (!digits) {
    return { available: false, reason: 'No mobile number is recorded for this customer' };
  }

  if (!/^[6-9]\d{9}$/.test(digits)) {
    return {
      available: false,
      reason:
        'The recorded mobile number is not a valid 10-digit Indian number. ' +
        'Correct the customer record to enable this.',
    };
  }

  const message = composeMessage(input);

  return {
    available: true,
    /* encodeURIComponent, not a template — the message contains newlines and
       may contain a customer name with characters that would otherwise break
       the query string. */
    url: `https://wa.me/${COUNTRY_CODE}${digits}?text=${encodeURIComponent(message)}`,
    message,
  };
}
