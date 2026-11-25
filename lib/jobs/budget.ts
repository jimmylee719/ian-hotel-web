/** After this many external calls in a row fail (error answer or thrown), a reconcile run stops calling out. */
export const MAX_CONSECUTIVE_ERRORS = 5;

/** Why a reconcile run stopped issuing external calls before it was done (recorded in its job_runs result). */
export type StoppedEarly = "deadline" | "errors";

/**
 * A reconcile run's budget for external calls (gateway / channel): a wall-clock deadline from the run's start,
 * and a limit on consecutive errors (a provider that is down is not asked about every item, one timeout at a
 * time). `clock` is the real clock (the job's `now` is the scheduled time, not elapsed time); tests inject one.
 */
export class CallBudget {
  private readonly deadline: number;
  private consecutiveErrors = 0;
  stoppedEarly: StoppedEarly | undefined;

  constructor(budgetMs: number, private readonly clock: () => number = Date.now) {
    this.deadline = clock() + budgetMs;
  }

  /** Whether another external call may be issued; once false it stays false and stoppedEarly says why. */
  canCall(): boolean {
    if (this.stoppedEarly) return false;
    if (this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) this.stoppedEarly = "errors";
    else if (this.clock() >= this.deadline) this.stoppedEarly = "deadline";
    return !this.stoppedEarly;
  }

  /** Record one external call's outcome: an error counts toward the limit, an answer resets it. */
  record(ok: boolean): void {
    this.consecutiveErrors = ok ? 0 : this.consecutiveErrors + 1;
  }
}
