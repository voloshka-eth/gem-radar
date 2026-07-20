# Robinhood Stages v1

**Дата:** 2026-07-20  
**Версія стратегії:** `robinhood-stages-v1`  
**Статус:** paper-only, без реальних транзакцій

## Мета зміни

Robinhood раніше проходив через спільний `Stage0` для Ethereum і Base. Через глобальні пороги `MIN_LIQUIDITY_USD=5000` та `MIN_FDV_USD=10000` велика частина молодих Robinhood-пулів відсіювалася ще до on-chain перевірки. Водночас токени зі score нижче 50 записувалися у `research_paper_entries`, але не отримували повного `paper_entries -> paper_exits` lifecycle.

Зміна відокремлює правила Robinhood від ETH/Base, версіонує їх і створює дві незалежні paper-когорти. Історичні записи не переписуються.

## Нова система стадій

| Stage | Перевірка | Результат |
|---|---|---|
| `R0_IDENTITY` | Заблокований ticker та наявність quote asset | Явно заблоковані запуски не рухаються далі |
| `R1_AGE` | Вік пулу; після 6 годин потрібен mature momentum | Старий тихий пул відсіюється, активний mature-пул може пройти |
| `R2_REPORTED_MARKET` | Reported liquidity, FDV і bootstrap activity | Формує discovery lane до дорогих on-chain запитів |
| `R3_PROVIDER_CONTRACT` | Контрактний результат і статус provider-а | Допускає лише чистий `CONTRACT_UNKNOWN` з `NO_RISK_PROVIDER_SUPPORT` |
| `R4_EXECUTABLE_LIQUIDITY` | On-chain verification, depth та TVL | Потрібні depth >= $100 і on-chain TVL >= $200 |
| `R5_SCORE_ROUTING` | Routing, а не hard safety verdict | Score >=50 йде у `PRIMARY`, score 30-49.99 у `SHADOW` |
| `R6_STATIC_SAFETY` | Robinhood bytecode/static safety | Відсіює підтверджені небезпечні bytecode-патерни перед paper entry |

## Discovery lanes

- `robinhood_standard`: reported liquidity >= $5,000.
- `robinhood_bootstrap_active`: liquidity $2,500-$4,999 і виконується хоча б одна умова: volume 5m >= $250, tx 1h >= 5 або buys 1h >= 3.
- `robinhood_mature_momentum`: пул старший шести годин, але має volume 1h >= $1,000, tx 1h >= 20 або buys 1h >= 10.
- `robinhood_reported_data_missing`: неповні reported-поля не є автоматичним reject; остаточний допуск все одно вимагає executable on-chain liquidity.

Robinhood FDV range для discovery: `$1,000-$50,000,000`. Ці пороги не змінюють ETH/Base `Stage0`.

## Paper routing

### Primary

- `strategyVersion=robinhood_stages_v1_primary`
- `riskCohort=ROBINHOOD_STATIC_SAFE`
- `exitPolicy=SAFE_LADDER`
- `benchmarkEligible=true`

### Shadow

- `strategyVersion=robinhood_stages_v1_shadow`
- `riskCohort=ROBINHOOD_STAGE_SHADOW`
- `exitPolicy=SOFT_RISK_2X`
- `benchmarkEligible=false`

Shadow тепер створює звичайний `PaperPosition`, тому автоматично отримує price evaluation та `paper_exits`. Він більше не є ізольованим рядком у `research_paper_entries`. Primary і shadow не змішуються в основній метриці.

## Replay на наявних логах

Вікно replay: `2026-07-19T18:00:02Z` - `2026-07-20T00:00:02Z`. Аналізувався останній запис для кожної унікальної пари token/pool.

- Старий rejected dataset: 937 унікальних Robinhood token/pool.
- 892 з них старий Stage0 відкинув як `liquidity_too_low`.
- Нова discovery-система пропустила б 208 із 937 до on-chain перевірки: 198 через active bootstrap і 10 через standard lane.
- Серед старих `liquidity_too_low` нова система повернула б 186 кандидатів.
- 689 bootstrap-пулів залишилися б rejected через недостатню активність, 17 через liquidity нижче $2,500, 22 як old and quiet, 1 через надмірний FDV.

Окремий replay старого Robinhood paper gate містив 148 унікальних оцінених token/pool:

- 100 були відкинуті лише через score нижче 50.
- 45 із них мали score 30-49.99 і тепер потрапили б у full-lifecycle shadow.
- 55 мали score нижче 30 і залишилися б rejected.
- On-chain hard gates залишили 28 low-TVL, 16 unverified-liquidity та 4 low-depth випадки поза paper positions.

Discovery replay та paper-gate replay є різними послідовними зрізами, тому їх не можна додавати як одну end-to-end кількість сигналів.

## Зміни в коді та логах

- Додано окремий pure gate `src/collector/robinhood-stage-gate.ts`.
- Collector обирає Robinhood stages лише для chain `robinhood`; ETH/Base використовують попередній gate.
- Кожне Robinhood stage-рішення пишеться у raw log як `source=robinhood_stage_gate` зі `stage_version`, stage, decision, reason та lane.
- Додано незалежні env-пороги `ROBINHOOD_STAGE_*` і `ROBINHOOD_SHADOW_MIN_SCORE`.
- Додано unit-тести стадій та integration-перевірки primary/shadow routing.

## Обмеження дослідження

Replay показує зміну throughput, а не доведений edge. Нові пороги не можна оцінювати як прибуткові, доки primary і shadow не отримають достатню forward-вибірку з executable exits. Для порівняння слід рахувати precision до 2x, expectancy, rug rate та time-to-2x окремо за `strategyVersion` і не переналаштовувати v1 на тій самій вибірці.
