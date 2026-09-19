/**
 * Form fields.
 *
 * Each field owns its label and its error message, and wires them to the input
 * with `aria-describedby` / `aria-invalid`. Spec section 21 asks for
 * "meaningful validation messages"; a message a screen reader cannot associate
 * with its input is only meaningful to some users.
 */
import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cn } from '@/lib/format';

const CONTROL =
  'block w-full rounded-lg border-0 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm ' +
  'ring-1 ring-inset ring-slate-300 placeholder:text-slate-400 ' +
  'focus:ring-2 focus:ring-inset focus:ring-brand-600 focus:outline-none ' +
  'disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500';

const INVALID = 'ring-red-400 focus:ring-red-500';

interface FieldShellProps {
  id: string;
  label?: ReactNode;
  hint?: ReactNode;
  error?: string | undefined;
  required?: boolean | undefined;
  children: ReactNode;
}

function FieldShell({ id, label, hint, error, required, children }: FieldShellProps) {
  return (
    <div>
      {label && (
        <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-slate-700">
          {label}
          {required && (
            <span className="ml-0.5 text-red-500" aria-hidden>
              *
            </span>
          )}
        </label>
      )}
      {children}
      {error ? (
        <p id={`${id}-error`} className="mt-1.5 text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1.5 text-sm text-slate-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

type Common = {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string | undefined;
};

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & Common
>(function Input({ label, hint, error, className, id, required, ...rest }, ref) {
  const generated = useId();
  const fieldId = id ?? generated;

  return (
    <FieldShell id={fieldId} label={label} hint={hint} error={error} required={required}>
      <input
        ref={ref}
        id={fieldId}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${fieldId}-error` : hint ? `${fieldId}-hint` : undefined}
        className={cn(CONTROL, error && INVALID, className)}
        {...rest}
      />
    </FieldShell>
  );
});

export const Select = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement> & Common
>(function Select({ label, hint, error, className, id, required, children, ...rest }, ref) {
  const generated = useId();
  const fieldId = id ?? generated;

  return (
    <FieldShell id={fieldId} label={label} hint={hint} error={error} required={required}>
      <select
        ref={ref}
        id={fieldId}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${fieldId}-error` : undefined}
        className={cn(CONTROL, 'pr-8', error && INVALID, className)}
        {...rest}
      >
        {children}
      </select>
    </FieldShell>
  );
});

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement> & Common
>(function Textarea({ label, hint, error, className, id, required, ...rest }, ref) {
  const generated = useId();
  const fieldId = id ?? generated;

  return (
    <FieldShell id={fieldId} label={label} hint={hint} error={error} required={required}>
      <textarea
        ref={ref}
        id={fieldId}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${fieldId}-error` : undefined}
        className={cn(CONTROL, 'min-h-[88px] resize-y', error && INVALID, className)}
        {...rest}
      />
    </FieldShell>
  );
});
