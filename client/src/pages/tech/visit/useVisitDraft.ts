/**
 * Visit draft, saved on the phone as the technician types.
 *
 * Section 21 asks for "offline-friendly patterns where practical". The most
 * practical one is also the most valuable: a technician typing a diagnosis on a
 * doorstep, with one bar of signal, loses nothing if the page reloads, the
 * browser is backgrounded to take a call, or a back-swipe fires by accident.
 *
 * The draft is cleared only once the server has the resolution — never on
 * navigation, so abandoning the flow half way and coming back resumes exactly
 * where it stopped.
 *
 * ## One draft per technician, per visit
 *
 * Drafts were first keyed by complaint alone, and two things went wrong:
 *
 *  - When the service center sent the work back and booked a revisit, the new
 *    visit opened with the old visit's problem, work and result filled in —
 *    the text the center had just rejected, one tap from being sent again.
 *  - On a phone shared between technicians, the next person to open the job
 *    saw the previous technician's unsent notes.
 *
 * So the key names the signed-in technician and the visit. A new visit starts
 * empty, and nobody reads anyone else's draft. Drafts for visits that are over
 * are removed when the job is next opened (`forgetFinishedDrafts`).
 */
import { useCallback, useEffect, useState } from 'react';

export interface VisitDraft {
  step: number;
  problemFound: string;
  diagnosisNotes: string;
  workDetails: string;
  workRemarks: string;
  result: string;
  resolutionRemarks: string;
  customerFeedback: string;
  happyCode: string;
}

const EMPTY: VisitDraft = {
  step: 0,
  problemFound: '',
  diagnosisNotes: '',
  workDetails: '',
  workRemarks: '',
  result: '',
  resolutionRemarks: '',
  customerFeedback: '',
  happyCode: '',
};

const PREFIX = 'cooler-crm.visit-draft';

const keyFor = (userId: string, complaintId: string, visitId: string) =>
  `${PREFIX}.${userId}.${complaintId}.${visitId}`;

/* Storage can be full, disabled or unreadable; the flow still works, it just
   will not survive a reload. Not worth interrupting the technician over. */

function read(key: string | null): VisitDraft {
  if (!key) return EMPTY;
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...EMPTY, ...(JSON.parse(raw) as Partial<VisitDraft>) } : EMPTY;
  } catch {
    return EMPTY;
  }
}

function write(key: string, draft: VisitDraft): void {
  try {
    /* An empty draft is removed rather than stored, or every finished job
       would leave a blank entry behind on the phone. */
    if (JSON.stringify(draft) === JSON.stringify(EMPTY)) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(draft));
  } catch {
    /* See above. */
  }
}

function remove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* See above. */
  }
}

export function useVisitDraft({
  userId,
  complaintId,
  visitId,
}: {
  userId: string | undefined;
  complaintId: string;
  /** The visit in progress; none while it is loading or when there is none. */
  visitId: string | undefined;
}) {
  const key = userId && visitId ? keyFor(userId, complaintId, visitId) : null;
  const [state, setState] = useState(() => ({ key, draft: read(key) }));

  /* A different visit or technician is a different draft: load that one
     rather than carrying this one's text across. Set during render, which
     React re-runs at once without showing the stale draft. */
  let current = state;
  if (state.key !== key) {
    current = { key, draft: read(key) };
    setState(current);
  }

  useEffect(() => {
    if (state.key) write(state.key, state.draft);
  }, [state]);

  const update = useCallback(
    <K extends keyof VisitDraft>(field: K, value: VisitDraft[K]) =>
      setState((previous) => ({ ...previous, draft: { ...previous.draft, [field]: value } })),
    [],
  );

  /**
   * Drops a visit's draft once the server has its resolution.
   *
   * By visit rather than "the current one": when a lost reply is confirmed
   * after the fact, the refreshed visit list may already have moved the
   * screen off that visit.
   */
  const discard = useCallback(
    (finishedVisitId: string) => {
      if (!userId) return;
      const finished = keyFor(userId, complaintId, finishedVisitId);
      remove(finished);
      setState((previous) => (previous.key === finished ? { ...previous, draft: EMPTY } : previous));
    },
    [userId, complaintId],
  );

  return { draft: current.draft, update, discard };
}

/**
 * Removes drafts, by anyone on this phone, for visits of a job that are over.
 *
 * A visit that is completed or cancelled can never be submitted, so its draft
 * is only customer details left lying on the phone. Also removes the draft the
 * previous version kept per complaint, which named no visit or technician.
 */
export function forgetFinishedDrafts(complaintId: string, finishedVisitIds: string[]): void {
  try {
    remove(`${PREFIX}.${complaintId}`);
    if (finishedVisitIds.length === 0) return;

    const endings = finishedVisitIds.map((visitId) => `.${complaintId}.${visitId}`);
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(`${PREFIX}.`) && endings.some((ending) => key.endsWith(ending))) {
        localStorage.removeItem(key);
      }
    }
  } catch {
    /* Storage unavailable: nothing was stored either. */
  }
}
