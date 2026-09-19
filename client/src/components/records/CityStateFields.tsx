/**
 * Where something is: a state from the list, a city typed by hand
 * (DECISIONS.md section 32).
 *
 * The client asked for this: nobody should have to create a city before they
 * can enter a customer's address. So the city is a plain text box that
 * suggests the cities already in use — pick one, or type a new one — and the
 * server files it under the state, creating the record itself the first time
 * a name is typed.
 *
 * The state is a list, not a box, because "UP", "U.P." and "Uttar pradesh"
 * typed into three forms are three different places to every report and to
 * the service-centre matching. Suggestions narrow to the chosen state for the
 * same reason a city is filed under one: two states can hold a Hyderabad.
 */
import { useId } from 'react';
import { useCities } from '@/components/records/Records';
import { Input, Select } from '@/components/ui/Field';
import { INDIAN_STATES } from '@/lib/india';

export interface CityStateValue {
  cityName: string;
  state: string;
}

export function StateSelect({
  value,
  onChange,
  error,
  label = 'State',
  required = true,
}: {
  value: string;
  onChange: (state: string) => void;
  error?: string | undefined;
  label?: string;
  required?: boolean;
}) {
  return (
    <Select
      label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      error={error}
      required={required}
    >
      <option value="">Choose a state</option>
      {INDIAN_STATES.map((state) => (
        <option key={state} value={state}>
          {state}
        </option>
      ))}
    </Select>
  );
}

/**
 * The city box. `state` narrows the suggestions; an empty state suggests
 * every city already in use, so the field still helps before a state is
 * chosen.
 */
export function CityInput({
  value,
  onChange,
  state,
  error,
  label = 'City',
  required = true,
  hint,
}: {
  value: string;
  onChange: (city: string) => void;
  state: string;
  error?: string | undefined;
  label?: string;
  required?: boolean;
  hint?: string;
}) {
  const listId = useId();
  const cities = useCities({ includeInactive: true });

  const suggestions = (cities.data?.items ?? [])
    .filter((city) => !state || city.state === state)
    .map((city) => city.name)
    .filter((name, index, all) => all.indexOf(name) === index)
    .sort((a, b) => a.localeCompare(b));

  return (
    <>
      <Input
        label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        error={error}
        required={required}
        list={listId}
        autoComplete="off"
        placeholder="Type the city"
        hint={hint ?? (suggestions.length > 0 ? 'Pick a suggestion or type a new city' : undefined)}
      />
      <datalist id={listId}>
        {suggestions.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
    </>
  );
}

/** The pair, side by side: state first, because it narrows the city. */
export function CityStateFields({
  value,
  onChange,
  errors,
  cityLabel,
  stateLabel,
}: {
  value: CityStateValue;
  onChange: (next: CityStateValue) => void;
  errors?: { cityName?: string | undefined; state?: string | undefined };
  cityLabel?: string;
  stateLabel?: string;
}) {
  return (
    <>
      <StateSelect
        label={stateLabel ?? 'State'}
        value={value.state}
        onChange={(state) => onChange({ ...value, state })}
        error={errors?.state}
      />
      <CityInput
        label={cityLabel ?? 'City'}
        value={value.cityName}
        state={value.state}
        onChange={(cityName) => onChange({ ...value, cityName })}
        error={errors?.cityName}
      />
    </>
  );
}
