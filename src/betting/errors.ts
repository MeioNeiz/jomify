// Thrown by store transactions when an account can't cover a stake.
// Caught centrally in `wrapCommand` so betting commands surface a
// user-friendly message instead of "Something went wrong."
export class InsufficientBalanceError extends Error {
  readonly have: number;
  readonly need: number;
  constructor(have: number, need: number) {
    super(`Insufficient balance: have ${have}, need ${need}`);
    this.name = "InsufficientBalanceError";
    this.have = have;
    this.need = need;
  }
}
