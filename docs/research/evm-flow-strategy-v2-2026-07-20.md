# EVM Flow Strategy v2

**Date:** 2026-07-20  
**Status:** paper-only, frozen forward experiment

## Why this version exists

Flow v1 could not be evaluated honestly while Base was tens of blocks behind and
one rejected `eth_getLogs` address array aborted the complete block batch. The
available canonical sample was also too small for threshold tuning: two Ethereum
market samples and no Base trigger.

The v2 change therefore separates infrastructure repair from strategy research.
V1 remains unchanged as the control. V2 is an independent paper strategy and does
not rewrite historical entries or outcomes.

## Data-plane changes

- Swap log address batches start at 32 and recursively split to one address when a
  provider rejects arrays. The supported size is cached per chain and AMM model.
- Successful shards advance only their own watch cursors. Failed shards retain the
  old cursor and are recorded in `evm_flow_backfill_ranges` until resolved.
- Block transaction reads use settled results. A failed block cannot fabricate a
  router address as the buyer and rewinds the affected watch coverage.
- `DEGRADED_SHADOW` and `PREFLIGHT_WAIT` do not consume a strategy trigger.
- A primary signal requires complete coverage, lag at most two blocks, and a latest
  qualifying swap no older than 15 seconds.
- RPC health is stored in `evm_rpc_health_samples`; no additional CSV was added.
- Robinhood candidates discovered by the collector now enter the same direct swap
  flow watcher and four-second HTTP/WSS head path as ETH/Base.

## Frozen entry strategies

`evm_flow_precision_v2` uses the pre-registered ETH/Base fresh and mature rules,
including on-chain TVL of USD 10k-50k, wallet concentration, buyer/seller overlap,
net buying, multi-block persistence, and bounded momentum.

`robinhood_flow_precision_v2` uses the pre-registered Robinhood fresh and mature
rules with lower absolute volume requirements. Legacy score, FDV, LP lock, token
social profile, and ticker are features rather than v2 entry gates.

Every v2 admission obtains directional USD 20 probes for quote-to-token entry and
token-to-quote exit. It requires USD 100 depth, entry slippage at most 3%, and a
zero-move round-trip multiple of at least 0.8 after current gas and taxes.

Creator reputation is applied only when the provider or token creation evidence
resolves to an EOA. Contract factories are not assigned the outcomes of all tokens
created through them. One confirmed prior rug blocks a v2 creator.

## Exit and measurement

Safe v2 positions use `PROTECTED_LADDER_V2`: 80% at executable 2x, 15% at 10x,
and 5% at 1000x. Before 2x, two weak 30-second flow windows with ratio below 0.75
and executable drawdown of at least 15% close the position. A material creator sell
closes it immediately. A green position closes after 30 minutes and every remaining
position closes after 60 minutes. V1 keeps its previous exit policy.

The benchmark now reports signal-level 1h precision from actual ladder events,
net expectancy, expectancy capped at 10x, largest-winner PnL concentration, rug
rate, latency, liquidity band, RPC health, recall, and paired strategy outcomes.
One pool remains one market sample even when several strategies observe it.

## Promotion contract

Thresholds remain frozen until each chain has 100 unique, fully observed v2
triggers. Promotion requires positive net and capped expectancy, better paired 2x
precision than v1, valid RPC health, and no single position contributing more than
25% of positive PnL. Real transactions remain disabled.
