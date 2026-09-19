/**
 * Names for recorded part usage.
 *
 * A usage record carries the part's id, not its name. The Parts step used to
 * look names up in its own picker list — the first 100 parts, the most the
 * server returns at once — so with a longer catalogue, a part recorded from
 * further down read just "Part", and a technician checking their work could
 * not tell what they had recorded.
 *
 * A name now comes from, in order:
 *
 *  1. the record itself, if the server includes the part with it;
 *  2. parts this app has already seen in the session — every picker search
 *     result, and the part just recorded;
 *  3. the parts list, a page at a time, until every missing id is found.
 *     Retired parts are included: a part fitted last month may have been
 *     retired since, and its record still needs a name.
 *
 * Step 3 is only for names the session has not met, such as after a reload.
 * The server joining the part name into usage records, as it already does for
 * part requests, would make it unnecessary.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Paged, Part, PartUsage } from '@/lib/types';

/* Part names are company-wide reference data, the same for every user, so one
   list for the whole session is safe to share. */
const seen = new Map<string, string>();

export function rememberParts(parts: Array<Pick<Part, 'id' | 'name'>>): void {
  for (const part of parts) seen.set(part.id, part.name);
}

export function usePartNames(records: PartUsage[]) {
  for (const record of records) {
    if (record.part) seen.set(record.partId, record.part.name);
  }

  const missing = [...new Set(records.map((record) => record.partId))]
    .filter((partId) => !seen.has(partId))
    .sort();

  const lookup = useQuery({
    queryKey: ['part-names', missing],
    enabled: missing.length > 0,
    staleTime: Infinity,
    queryFn: async () => {
      const wanted = new Set(missing);
      for (let page = 1; wanted.size > 0; page += 1) {
        const result = await api<Paged<Part>>('/parts', {
          query: { includeInactive: true, limit: 100, page },
        });
        rememberParts(result.items);
        for (const part of result.items) wanted.delete(part.id);
        if (page >= result.totalPages) break;
      }
      /* Ids no page contained stay unnamed; the caller says so. */
      return [...wanted];
    },
  });

  /** The part's name; `undefined` while it is still being looked up or could not be. */
  const nameOf = (partId: string): string | undefined => seen.get(partId);

  return {
    nameOf,
    /** A readable stand-in for a name not (yet) known. */
    fallback: lookup.isFetching
      ? 'Loading…'
      : lookup.isError
        ? 'Part name not loaded'
        : 'Unknown part',
  };
}
