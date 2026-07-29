# Robinhood Low-Friction 2x v1

## Registration

- Registered: 2026-07-27 Europe/Warsaw
- Forward collection starts: `2026-07-26T23:05:55.000Z`
- Baseline Git commit: `31139dc96d4be8cbce33c2d7d8207b9653ad8320`
- Legacy Flow v3 hash: `8ff13f327b123672eabf1a3660a916ab72d733b2048a260fc0830d25accccc99`
- Forward strategy hash: `8a9ca827352edbd48e05c7227a521974f498ff8a09022596605a9ca25e25c749`
- Legacy paired exit hash: `c534cdd5da9acd6d30ab52bbf7bb350df75c21bb2b9de862bac2693202c966ed`
- Executable min-out paired exit hash: `d38aa557581b2c8051781ebbfe0771950b964e56ad88762303405fd5903bd1ed`
- Live execution: disabled

Existing database rows and CSV rows are historical controls. They must not be
recomputed under this configuration.

The initially generated forward hash
`046112aa81d97d0250af6aacbe9fc2700bea91e40678520e272ed77242f5c442`
was retired before its first signal. It classified friction from the buy side
only, while the motivating legacy field represented sell-side impact. No row
was created under the retired hash.

## Post-Hoc Evidence

The hypothesis was derived from Robinhood shadow positions opened after
2026-07-23 12:00 UTC. Ladder winners were conservatively capped at exactly 2x.

| Cohort | N | EV per signal | Profit factor | PnL ex-top-1 | PnL ex-top-3 |
| --- | ---: | ---: | ---: | ---: | ---: |
| All executable shadow | 556 | -$3.12 | 0.65 | negative | negative |
| Legacy $50 sell impact proxy <=1% | 90 | +$3.20 | 1.48 | +$267.94 | +$227.94 |
| Legacy $50 sell impact proxy 1-3% | 416 | -$4.39 | 0.53 | negative | negative |

The low-friction result appeared in both V2 (`n=27`, EV `+$3.23`) and V3
(`n=63`, EV `+$3.19`) pools and in both chronological halves. Its bootstrap
95% interval was approximately `[-$0.52, +$6.65]`, so the edge is not proven.

The source period contains one entry per token and pool: the result is not
pseudo-replication from repeated positions. A later audit with one additional
resolved sample found `91` unique low-friction pools. Three consecutive
chronological thirds remained positive at approximately `+$2.40`, `+$2.79`
and `+$4.91` per pool under the same conservative full-2x counterfactual.

These observations may only motivate the frozen forward test. They may not be
used to claim profitability or to retune the 1% threshold.

## Frozen Forward Cohorts

`LOW_FRICTION_PRIMARY` requires:

- executable $20 buy impact <=1%;
- executable $20 immediate-sell impact <=1%;
- depth >=$100;
- zero-move round trip >=0.8x;
- quote age <=5 seconds;
- complete data coverage and RPC lag <=2 blocks;
- no evidenced hard contract risk, blocked creator, or creator sell.

Executable entries where either side exceeds 1% but both remain at most 3% are
recorded as `HIGH_FRICTION_SHADOW`. The symmetric requirement is deliberate:
legacy `slippage_pct` was sourced from a pessimistic sell quote and reused by
the old buy model, so buy-only friction would not test the historical
hypothesis. Score, FDV, ticker, social profile and LP lock do not control
exposure.

## Paired Policies

Every eligible signal receives the same observed entry quote:

- `EXIT_A_FULL_2X`: sell 100% at the first executable net 2x.
- `EXIT_B_LADDER_80_15_5`: 80% at 2x, 15% at 10x, 5% at 1000x or terminal exit.
- `EXIT_C_90_10`: 90% at 2x, 10% at flow reversal or terminal exit.

All policies share the same hard stop, hard-risk exits, gas model, latency and
60-minute horizon.

Exit rungs are defined by the executable net price of the tokens sold relative
to the arm's blended entry cost. They are not defined by chart price or by the
total portfolio multiple after earlier partial proceeds. A delayed ladder sell
has a frozen `minOut`: if the later executable quote falls below both the rung
target and the registered 1% quote-deterioration allowance, the transaction is
recorded as failed and gas is charged, while no synthetic favorable sale is
created.

## Operational Corrections Before First Resolution

- `dev.bat` now starts Docker Desktop when needed, waits for readiness, applies
  migrations, builds once and launches one production-like main process without
  requiring VS Code. `AppModule` already owns the Solana services, so the old
  duplicate `start:solana` process and watch-mode restarts were removed.
- Fresh Robinhood swap watches are evaluated before historical outcome watches.
- Tick freshness is measured immediately before experiment preflight rather
  than from the beginning of a potentially long RPC cycle.
- The latest preflight outcome is persisted in
  `EvmPoolWatch.latestDataHealth.robinhoodExperiment` and summarized by the
  benchmark funnel.
- Robinhood log ranges now use the endpoint-tested 2,000-block window. Swap
  logs at or behind an individual pool cursor are discarded before decoding.
- Block timestamps and real `tx.from` identities are obtained with one
  `eth_getBlockByNumber(..., true)` request per swap-bearing block. The old
  header plus per-transaction fan-out was removed.
- Block reads use bounded concurrency. Transient 429/network errors no longer
  recursively split one failed batch into hundreds of RPC requests.
- Inverted backfill ranges are no longer persisted. Existing corrupt queue rows
  remain auditable but are terminally resolved as an operational repair; no
  trade, position, arm, or outcome row is rewritten.
- A missing or stale chain head now forces `signalEligible=false`. Active
  experiment watches receive RPC priority over ordinary discovery watches.
- Pipeline invalidation rate in bankroll readiness is calculated only from the
  current friction-schema and bankroll-policy hashes inside the
  `LOW_FRICTION_PRIMARY` universe. Pre-policy experiments and high-friction
  shadow failures remain auditable but cannot poison or improve promotion.
- These changes alter collection correctness and latency only. They do not
  change the frozen 1% friction threshold or historical outcomes.

## Acceptance

The first 100 resolved primary signals are diagnostic. Formal comparison starts
at 300 resolved paired signals and any selected policy requires a fresh
200-signal holdout. Promotion requires positive raw and 10x-capped expectancy,
positive PnL without the top winner, non-negative PnL without the top three,
profit factor above one, positive stress expectancy, reconciled execution-leg
accounting and an acceptable drawdown.

The benchmark enforces this as a chronological state machine:

- `COLLECTING_SELECTION`: fewer than 300 unique paired primary pools.
- `SELECTION_REJECTED`: no policy passes the frozen economic guardrails.
- `COLLECTING_HOLDOUT`: a policy passed selection, but fewer than 200 later
  untouched pools have resolved.
- `HOLDOUT_REJECTED`: observed economics, one-block latency plus 30% gas stress,
  paired confidence, drawdown, or pipeline validity failed.
- `PAPER_EDGE_VALIDATED`: all pre-registered paper guardrails passed.

Duplicate arm rows cannot increase the market sample count, and an incomplete
stress sample invalidates the holdout. Even `PAPER_EDGE_VALIDATED` does not
enable live execution.

## Execution Friction Addendum

A later fixed-bin audit covered `550` resolved legacy Robinhood positions.
The conservative full-2x counterfactual remained positive for the historical
friction proxy at `<=1%` (`n=92`, EV approximately `+$3.56`) and `<=0.5%`
(`n=71`, EV approximately `+$4.21`). All three chronological thirds were
positive in both groups. The unrestricted sample and the `1-2%` friction group
remained negative. This is a pre-registration hypothesis, not forward proof.

New records therefore persist the immutable feature schema
`robinhood_execution_friction_features_v1` with hash
`7d64347283a55f98140c77403b1bb5767695d06a683bff4787eb512ce3132abb`.
It separates exact $20 buy and immediate-sell impact into disjoint cohorts:

- both sides `<=0.5%`;
- both sides `<=1%`, excluding the first cohort;
- sell `<=1%` with buy `1-3%`;
- buy `<=1%` with sell `1-3%`;
- both sides `1-3%`.

Discovery source is persisted but remains observational. Source, score, TVL
and FDV are not new gates.

The head-processing path was also separated from 24-hour outcome marking.
Active swap and experiment watches remain in the latency-critical path;
expired research watches are evaluated in bounded background batches. This
does not modify entries or outcomes. It prevents hundreds of historical DB and
quote updates from delaying current swap reads. After deployment, the first
new experiment retained complete coverage through its confirmation window and
expired normally instead of being invalidated by pipeline health.

Quote-driven Gecko experiments may now be created when the last decoded swap
is older than 15 seconds, provided block coverage is complete and the exact
buy and sell quotes are no older than five seconds. Flow v1 eligibility still
requires the original swap-freshness rule, so the source lane cannot
contaminate that control.

Background 24-hour outcome work is throttled to a five-second cadence. Active
entry and exit evaluation remains block-driven; only non-critical historical
marking is delayed.

## Bankroll Candidate

The frozen historical counterfactual for `friction <=1%`, `$20` notional and a
full executable exit at exactly 2x contained `92` signals:

- `45/92` reached an executable 2x (`48.9%`);
- capped PnL was `+$327.94`, or `+$3.56` per signal;
- average winner was `+$20.00`, average observed loser was `-$12.17`;
- the corresponding break-even hit rate was `37.8%`;
- chronological max drawdown was `$84.31`;
- the longest losing streak was five;
- `95.9%` of rolling 20-signal windows were positive, although the worst
  window was `-$1.34` per signal.

These observations cover only four calendar days and therefore do not prove
stationarity. A block bootstrap is reported for stress visibility, but its
confidence is limited by the short source period and must not replace the
forward selection plus holdout.

The paper-only allocation policy
`robinhood_low_friction_bankroll_v1` is frozen at:

- `$1,000` virtual bankroll;
- `$20` per independent market signal;
- five concurrent primary signals and `$100` aggregate primary exposure;
- at most 20 new primary signals per UTC day;
- no new primary allocation after `$100` intraday realized drawdown.

Signals exceeding a limit become `BANKROLL_LIMIT_SHADOW`. Their counterfactual
arms remain observable, but they cannot improve or damage primary promotion
metrics. This preserves false-negative and opportunity-cost measurement
without pretending that unlimited correlated paper positions are one feasible
bankroll.

## Gecko Fixed Full-2x Lane

The robustness audit found one additional stable historical split:
`geckoterminal + friction proxy <=1%` contained `84` signals, reached 2x in
`52.4%`, and produced conservative full-2x EV of approximately `+$3.91` per
signal. Its three chronological thirds were positive. By contrast, the
unrestricted DexScreener-discovered cohort reached 2x in only `3.6%`.

This evidence is still post-hoc. It therefore created a new nested forward
lane rather than modifying the existing v1 control.

The first registration,
`robinhood_gecko_low_friction_full2x_v1`
(`aa7d5f6bb505ea3d87908593a79a699d13bfd325dfa1bcdb6c258965c9aa3010`),
was retired with zero resolved holdout samples after an execution audit found
that a delayed full-position sale could trigger near 2x but realize materially
less after current sell impact. Its rows remain unchanged and auditable.

The v2 registration was also retired with zero resolved holdout samples after
the execution scheduler could delay all three observed paired arms beyond the
five-second benchmark window. Its rows remain unchanged and excluded by their
measurement hashes.

The execution-correct registration is:

- version `robinhood_gecko_low_friction_full2x_v3`;
- hash `0c4ce443ddd1ecad748317378a19131894793c14ea2361c5ab646e7533afe828`;
- registered at `2026-07-27T02:15:00.000Z`;
- GeckoTerminal discovery and exact bidirectional $20 impact `<=1%`;
- fixed `EXIT_A_FULL_2X` policy;
- atomic shared t0 fill for the three observed exit-policy arms;
- executable rung-price accounting and delayed-sell `minOut`;
- one untouched 200-signal holdout, with no intermediate threshold selection.

Validation requires positive raw and 10x-capped EV, positive PnL excluding the
top winner, non-negative PnL excluding the top three, profit factor above one,
maximum drawdown at most `$200`, positive bootstrap 95% lower bound, positive
one-block-late plus 30% gas stress economics, and pipeline invalidation at most
5%. The lane shares counterfactual fills with v1, creates no extra market
sample, does not rewrite older rows, and cannot enable live execution.
