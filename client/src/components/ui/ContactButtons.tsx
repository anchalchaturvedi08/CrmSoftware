/**
 * Call and WhatsApp a customer, one click each.
 *
 * No WhatsApp API (decided 2026-09-17, DECISIONS.md section 29): the WhatsApp
 * button opens the customer's chat in WhatsApp — on a phone the app, on a
 * computer WhatsApp Desktop or WhatsApp Web — with nothing typed and nothing
 * sent. The person writes and sends the message themselves. Call opens the
 * phone's dialler, or the computer's calling app.
 *
 * Shown only for a valid 10-digit Indian mobile, the same rule the server
 * applies to the Happy Code message, so a mistyped number says so rather than
 * opening a chat with a stranger.
 */
import { MessageCircle, Phone } from 'lucide-react';
import { cn } from '@/lib/format';

/** The number as ten digits, or null when it cannot be called or messaged. */
export function dialableMobile(mobile: string | null | undefined): string | null {
  const digits = (mobile ?? '').replace(/\D/g, '');
  const local =
    digits.length === 12 && digits.startsWith('91')
      ? digits.slice(2)
      : digits.length === 11 && digits.startsWith('0')
        ? digits.slice(1)
        : digits;
  return /^[6-9]\d{9}$/.test(local) ? local : null;
}

export const callLink = (mobile: string) => `tel:+91${mobile}`;
export const whatsAppChatLink = (mobile: string) => `https://wa.me/91${mobile}`;

const BUTTON =
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg bg-white font-medium ' +
  'text-slate-700 shadow-sm ring-1 ring-inset ring-slate-300 transition-colors hover:bg-slate-50 ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600';

export function ContactButtons({
  mobile,
  name,
  compact = false,
  className,
}: {
  mobile: string | null | undefined;
  /** Who is being contacted, for screen readers: "Call Anita Sharma". */
  name?: string | undefined;
  /** Icons only, for table rows. */
  compact?: boolean;
  className?: string;
}) {
  const number = dialableMobile(mobile);
  const who = name ?? 'customer';

  if (!number) {
    return compact ? null : (
      <p className={cn('text-xs text-slate-500', className)}>No valid mobile number to call or message.</p>
    );
  }

  const size = compact ? 'size-8' : 'h-9 px-3 text-sm';

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <a
        href={callLink(number)}
        className={cn(BUTTON, size)}
        aria-label={`Call ${who}`}
        title={compact ? `Call ${who}` : undefined}
      >
        <Phone className="size-4 text-brand-700" aria-hidden />
        {!compact && 'Call'}
      </a>
      <a
        href={whatsAppChatLink(number)}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(BUTTON, size)}
        aria-label={`WhatsApp ${who}`}
        title={compact ? `WhatsApp ${who}` : undefined}
      >
        {/* WhatsApp's own green, so the button is recognisable at a glance. */}
        <MessageCircle className="size-4 text-[#1da851]" aria-hidden />
        {!compact && 'WhatsApp'}
      </a>
    </div>
  );
}
