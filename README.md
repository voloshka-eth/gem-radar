# Gem Radar — M2A

Ethereum / Base new-token research system. **Paper trading only — no private keys, no real trades.**

## What M2A does (and doesn't do)

M2A adds a **Contract Risk Engine** on top of M1's collector pipeline. Every token that passes
Stage 0 is now checked against GoPlus (primary) and Honeypot.is (supplementary) before it is
persisted to the database.

**M2A DOES:**
- Query GoPlus Token Security API (free, no key required)
- Query Honeypot.is as supplementary confirmation
- Hard-reject tokens with dangerous contract flags
- Log all risk-check results to `logs/raw/contract_risk_checks.csv`
- Log all hard-rejected tokens to `logs/decisions/contract_rejected_tokens.csv`
- Persist risk check rows to the `contract_risk_checks` DB table for safe/unknown tokens

**M2A does NOT:**
- Verify liquidity is real (on-chain reserves — M3)
- Detect wash trading or fake volume
- Score candidates
- Open paper trades
- Use private keys, auto-buy, sniper logic, or real trading of any kind

**Decision values:** `CONTRACT_SAFE` | `CONTRACT_REJECT` | `CONTRACT_UNKNOWN`

`CONTRACT_UNKNOWN` = GoPlus was unavailable; the token still passes through (collection
continues without blocking on API failures).

Every entry in `logs/raw/new_pools.csv` now means: *"this pool passed Stage 0 AND was not
hard-rejected by the contract risk engine."*

---

## Architecture

```
Collectors (GeckoTerminal + DexScreener, every COLLECTOR_POLL_INTERVAL_MS)
        │
        ▼
Stage 0  Cheap gate  ← deterministic filter on REPORTED data only
        │  fail → logs/decisions/rejected_tokens.csv
        │  pass
        ▼
Risk Engine (M2A)   ← GoPlus + Honeypot.is contract safety check
        │  CONTRACT_REJECT → logs/decisions/contract_rejected_tokens.csv (NOT persisted)
        │  CONTRACT_SAFE | CONTRACT_UNKNOWN
        ▼
Persist to PostgreSQL + logs/raw/new_pools.csv
                     + logs/raw/contract_risk_checks.csv

[M2B] On-chain liquidity verify → viem reads against actual reserves
[M2C] Scoring Engine → finalGemScore
[M2D] Paper Trading → open/track/exit simulated positions
[M3]  On-chain slippage simulator
[M4]  Reporting, Telegram alerts
[M5]  Holder distribution, deployer reputation
```

---

## Stage 0 gate — what it actually checks

Stage 0 is a cheap pre-filter using only reported API data. It is NOT a safety check.

| Check | What it uses | What it cannot tell you |
|---|---|---|
| Quote asset membership | API-reported pair metadata | Whether the pair is genuine |
| Pool age ≤ `NEW_POOL_MAX_AGE_HOURS` | API-reported `pool_created_at` | Whether the timestamp is accurate |
| Reported liquidity ≥ `MIN_LIQUIDITY_USD` | API-reported `reserve_in_usd` | Whether liquidity is real or fake |
| FDV within `[MIN_FDV_USD, MAX_FDV_USD]` | API-reported `fdv_usd` | Whether FDV is inflated by wash trades |

**Rejection reasons in `rejected_tokens.csv`:**

| reason | meaning |
|---|---|
| `quote_asset_not_accepted` | Quote token is not WETH/USDC/USDT/DAI |
| `pool_too_old` | Pool is older than `NEW_POOL_MAX_AGE_HOURS` |
| `liquidity_too_low` | Reported liquidity below `MIN_LIQUIDITY_USD` |
| `fdv_too_low` | Reported FDV below `MIN_FDV_USD` |
| `fdv_too_high` | Reported FDV above `MAX_FDV_USD` |

All rejection rows include `liquidity_trust_level=REPORTED_ONLY` and `onchain_verified=false`
to make it explicit that no on-chain verification was performed.

---

## Contract risk gate (M2A) — hard-reject rules

GoPlus is the primary source. Honeypot.is is supplementary (failure is non-fatal — the token
still passes if GoPlus returned data). If GoPlus itself is unavailable, the decision is
`CONTRACT_UNKNOWN` and the token is still persisted (collection must not be blocked by API
outages).

| Reject reason | Trigger |
|---|---|
| `honeypot_detected` | GoPlus or Honeypot.is flags `is_honeypot = true` |
| `cannot_sell` | Honeypot.is detects the token cannot be sold |
| `sell_tax_X.Xpct` | Sell tax > 10 % (X.X = actual percentage) |
| `buy_tax_X.Xpct` | Buy tax > 10 % |
| `owner_can_mint` | GoPlus `is_mintable = "1"` |
| `blacklist_function_detected` | GoPlus `is_blacklisted = "1"` |
| `trading_can_be_paused` | GoPlus `transfer_pausable = "1"` |
| `owner_can_change_fees` | GoPlus `can_take_back_ownership = "1"` |
| `proxy_risk` | GoPlus `is_proxy = "1"` |

Multiple reasons are accumulated in the same rejection row (not short-circuited).

**APIs used — no API keys required:**
- GoPlus: `https://api.gopluslabs.io/api/v1/token_security/{chainId}?contract_addresses={addr}`
- Honeypot.is: `https://api.honeypot.is/v2/IsHoneypot?address={addr}&chainID={chainId}`

---

## Setup

### Prerequisites

- Node.js >= 20
- Docker + Docker Compose

### 1 — Clone and install

```bash
cd rocket_alert
npm install
npm run db:generate
```

> `node_modules/` and `dist/` are in `.gitignore` and must never be committed.

### 2 — Configure

```bash
copy .env.example .env
# Edit .env — at minimum set ETHEREUM_RPC_URL and BASE_RPC_URL.
# Public RPCs are pre-filled but Alchemy/Infura are more reliable.
```

### 3 — Start infrastructure

```bash
docker compose up -d
# Postgres on :5432, Redis on :6379
# Wait ~10s for Postgres to initialise before the next step
```

### 4 — Push schema

```bash
npm run db:push        # dev only — for prod use: npm run db:migrate:deploy
```

### 5 — Run

```bash
npm run start:dev      # hot-reload
npm run start:prod     # compiled build (run npm run build first)
```

The first collection cycle fires after `COLLECTOR_POLL_INTERVAL_MS` (default 2 min).
Watch `logs/raw/new_pools.csv` for candidates and `logs/decisions/rejected_tokens.csv` for rejects.

---

## Run tests

```bash
npm test               # run all tests once
npm run test:watch     # watch mode
npm run test:cov       # with coverage
```

Expected output:

```
PASS src/collector/stage0-gate.spec.ts
PASS src/file-logger/file-logger.spec.ts
PASS src/collector/collector.service.spec.ts
PASS src/collector/geckoterminal/geckoterminal.service.spec.ts
PASS src/collector/dexscreener/dexscreener.service.spec.ts
PASS src/risk-engine/contract-risk-gate.spec.ts
PASS src/risk-engine/providers/goplus.service.spec.ts
PASS src/risk-engine/providers/honeypot.service.spec.ts

Tests: 115 passed, 115 total
```

---

## Log files

```
logs/
  raw/
    new_pools.csv               — pools that passed Stage 0 AND risk engine (M2A)
    source_payloads.jsonl       — per-cycle API summary (counts, not raw payloads)
    contract_risk_checks.csv    — GoPlus + Honeypot.is results for every checked token (M2A)
  decisions/
    rejected_tokens.csv         — Stage 0 rejects with full candidate context
    contract_rejected_tokens.csv — hard-rejected by contract risk engine (M2A)
    scoring_history.csv         — per-token score breakdown   [M2B+]
    watchlist_tokens.csv        — WATCHLIST decisions         [M2B+]
    paper_entries.csv           — paper trade opens          [M2B+]
    paper_exits.csv             — paper trade closes         [M2B+]
  reports/
    daily_report_YYYY-MM-DD.txt           [M2]
    paper_trade_report_YYYY-MM-DD.txt     [M2]
```

**Every CSV row includes:** `ts` (UTC ISO 8601 with Z suffix), `run_id` (UUID per collection cycle),
`schema_version` (currently `1.0.0`), `chain`, `token_address`, and `pool_address` where relevant.

> **CSV writer — single-process limitation.** The writer uses synchronous `fs.appendFileSync`
> and is safe for single-process use only. Running multiple collector instances or multiple BullMQ
> worker processes against the same `logs/` directory will produce interleaved writes and corrupt
> rows. Before scaling to multiple workers, replace the synchronous writer with a dedicated writer
> queue (e.g. a single BullMQ writer job) or redirect CSV output to a writer sidecar process.

> **Archiving logs.** `logs/` is in `.gitignore` and is never committed. To archive collected data,
> copy the `logs/` directory to a separate location before clearing it. The `raw_collector_payloads`
> Postgres table is the authoritative raw-data store; CSV files are supplementary.

### Sample `raw/new_pools.csv`

```
ts,run_id,schema_version,chain,token_address,token_symbol,token_name,pool_address,dex,quote_asset,price_usd,liquidity_usd,fdv_usd,vol_5m,vol_1h,vol_6h,vol_24h,buys_1h,sells_1h,pool_created_at,source
2024-06-17T14:32:00.000Z,a3f1b2c4-dead-beef-cafe-123456789abc,1.0.0,base,0x4fde...ff,PEPEBASE,Pepe on Base,0xaaaa...5555,aerodrome,WETH,0.00000432,84000,1340000,2100,18500,74000,210000,67,34,2024-06-17T12:05:00.000Z,geckoterminal
```

### Sample `decisions/rejected_tokens.csv`

```
ts,run_id,schema_version,chain,token_address,...,pool_age_minutes,stage,reason,source,liquidity_trust_level,onchain_verified
2024-06-17T14:32:01.000Z,a3f1b2c4-...,1.0.0,ethereum,0x1111...,SCAM,...,152,stage0,liquidity_too_low,geckoterminal,REPORTED_ONLY,false
```

---

## Collector cycle summaries

Each collection cycle stores a lightweight summary in two places:

| Location | What's stored | Why |
|---|---|---|
| `raw_collector_payloads` table (Postgres) | Cycle summary (`payload_type = "cycle_summary"`): normalised candidate counts, dedup counts, up to 100 addresses per source/chain pass | Audit trail queryable by `run_id` |
| `logs/raw/source_payloads.jsonl` | Same summary as JSONL | Human-readable, grep-able |

**M1 does NOT store full raw API responses.** `raw_collector_payloads` holds cycle-level
summaries — counts and a capped address list — not the raw JSON returned by GeckoTerminal or
DexScreener. Full raw API response capture (for replay and backtest hardening) is out of scope
for M1 and can be added later.

`pool_snapshots` is kept lean (no `rawJson` column) so it stays fast for time-series queries.

**DexScreener chain field:** DexScreener queries all enabled chains in a single pass; its cycle
summary rows use `chain = "multi"`. GeckoTerminal rows use the actual chain name (`ethereum`,
`base`, etc.).

---

## npm scripts

| Script | Description |
|---|---|
| `npm run start:dev` | Start with hot-reload |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run start:prod` | Run compiled build |
| `npm test` | Run all tests |
| `npm run test:cov` | Run tests with coverage |
| `npm run db:generate` | Regenerate Prisma client |
| `npm run db:push` | Push schema to DB (dev only) |
| `npm run db:migrate` | Create and run migration (dev) |
| `npm run db:migrate:deploy` | Deploy migrations (prod) |
| `npm run db:studio` | Open Prisma Studio |

---

## Milestone roadmap

| Milestone | Scope |
|---|---|
| **M1** ✅ | Collectors, Stage 0 gate, DB persistence, CSV logger, 69 tests |
| **M2A** ✅ | Contract Risk Engine: GoPlus + Honeypot.is, hard-reject gate, `contract_risk_checks` table, 115 tests |
| M2B | On-chain liquidity verify (viem reads against actual reserves) |
| M2C | Scoring Engine → finalGemScore |
| M2D | Paper Trading → open/track/exit simulated positions |
| M3 | On-chain slippage simulator |
| M4 | Reporting (daily TXT), Telegram alerts |
| M5 | Holder distribution, deployer reputation |
