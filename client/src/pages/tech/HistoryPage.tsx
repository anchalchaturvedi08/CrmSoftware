/**
 * History — the technician's finished visits (spec section 10, "Completed
 * history").
 *
 * Each card says what the visit came to — the result submitted, or why there
 * was none — because "completed" alone would count a locked door as a repair.
 *
 * Twenty at a time with a "Show more" button rather than infinite scroll: on a
 * phone that is the difference between reaching the tab bar and chasing it.
 */
import { useInfiniteQuery } from '@tanstack/react-query';
import { History as HistoryIcon } from 'lucide-react';
import { TechHeader } from '@/components/layout/TechLayout';
import { Button } from '@/components/ui/Button';
import { ErrorState, Skeleton } from '@/components/ui/States';
import { api } from '@/lib/api';
import type { Paged, VisitCard } from '@/lib/types';
import { JobCard } from './JobCard';

const PAGE_SIZE = 20;

export function HistoryPage() {
  const history = useInfiniteQuery({
    queryKey: ['visits', 'history'],
    queryFn: ({ pageParam }) =>
      api<Paged<VisitCard>>('/visits', {
        /* By when each visit finished — the time every card shows. Booking
           order can differ by days and would read as shuffled. */
        query: {
          status: 'COMPLETED',
          orderBy: 'completedAt',
          sort: 'desc',
          limit: PAGE_SIZE,
          page: pageParam,
        },
      }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page < last.totalPages ? last.page + 1 : undefined),
  });

  const visits = history.data?.pages.flatMap((page) => page.items) ?? [];
  const total = history.data?.pages[0]?.total ?? 0;

  return (
    <>
      <TechHeader
        title="History"
        subtitle={history.data ? `${total} finished ${total === 1 ? 'visit' : 'visits'}` : undefined}
      />

      <div className="px-4 pb-6 pt-4">
        {!history.data && !history.error ? (
          <div className="space-y-3" aria-busy aria-label="Loading history">
            <Skeleton className="h-40 rounded-2xl" />
            <Skeleton className="h-40 rounded-2xl" />
          </div>
        ) : history.error && !history.data ? (
          <div className="rounded-2xl bg-white">
            <ErrorState error={history.error} onRetry={() => void history.refetch()} />
          </div>
        ) : visits.length === 0 ? (
          <div className="mt-16 flex flex-col items-center px-6 text-center">
            <div className="mb-4 flex size-16 items-center justify-center rounded-full bg-slate-100 text-slate-500">
              <HistoryIcon className="size-8" />
            </div>
            <p className="text-base font-semibold text-slate-900">No finished visits yet</p>
            <p className="mt-1 text-sm text-slate-500">Visits you complete will be listed here.</p>
          </div>
        ) : (
          <>
            <div className="space-y-3">
              {visits.map((visit) => (
                <JobCard key={visit.id} visit={visit} />
              ))}
            </div>

            {history.hasNextPage && (
              <Button
                variant="secondary"
                size="lg"
                className="mt-4 h-12 w-full"
                loading={history.isFetchingNextPage}
                onClick={() => void history.fetchNextPage()}
              >
                Show more
              </Button>
            )}
          </>
        )}
      </div>
    </>
  );
}
