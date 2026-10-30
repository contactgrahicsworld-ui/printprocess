# Pricing formula (server-side, integer paise)

Implementation: `web/src/lib/pricing/engine.ts` (pure, unit-tested in `web/tests/unit/pricing.test.ts`).
Configuration: Admin → Settings (tables `price_settings`, `paper_size_rates`, `paper_types`, `services`).
All amounts are **integer paise** (₹1 = 100 paise). No floating point is used for money.

## Inputs per document
| Input | Source |
|---|---|
| `pages_total` | counted **server-side** from the stored file (pdf-lib); images = 1 |
| `pages_selected` | page-range parser (`web/src/lib/print/pages.ts`): ranges are validated against `pages_total`, de-duplicated, sorted and stored in normalised form (e.g. `"7,1-3,2-4"` → `"1-4,7"`) so what is charged is exactly what is printed |
| colour mode, duplex, paper size, copies (1–500), paper type, per-document services | customer, re-validated by the server |

## Sheet calculation (CONTRACT.md, identical in the print agent)
```
sheets_per_copy = duplex == DOUBLE ? ceil(pages_selected / 2) : pages_selected
total_sheets    = sheets_per_copy × copies
printed_sides   = pages_selected × copies
```
Odd pages in duplex use a blank back side: it costs a sheet but is **not** charged as a printed side.

## Price
```
base_rate      = price_settings.{bw|color}_{single|double}_side_paise      -- per printed side, A4
side_rate      = round_half_up( base_rate × paper_size_rates.multiplier_bp / 10000 )
print_charge   = side_rate × printed_sides
paper_charge   = paper_types.surcharge_per_sheet_paise × total_sheets        -- if a paper type is chosen
item_services  = Σ PER_DOCUMENT.amount  +  Σ PER_COPY.amount × copies       -- e.g. spiral binding, stapling
item_total     = print_charge + paper_charge + item_services

order_services = Σ PER_ORDER.amount                                         -- e.g. urgent
subtotal       = Σ item_total + order_services
adjustment     = max(0, price_settings.min_order_paise − subtotal)
total          = subtotal + adjustment
```
- "Single-side vs double-side per-side rates" are the two separate columns per colour mode
  (e.g. B/W ₹2.00/side single-sided, ₹1.50/side when double-sided).
- Paper size is a multiplier in basis points (10000 = 1.00×; seed: A4 1.00, A3 2.00, Legal 1.25).
  A size can be disabled.
- Rounding happens once, on the per-side rate (half-up, integer arithmetic via BigInt), so totals are exact
  multiples and reproducible.

## Worked example (seed prices)
12-page PDF, B/W, double-sided, pages `1-3,7,10-12`, 2 copies, stapling (₹2/copy), order marked Urgent (₹20):
- pages_selected 7 → sheets/copy 4 → total_sheets 8 → printed_sides 14
- print 14 × 150 = 2100; stapling 2 × 200 = 400 → item ₹25.00; + urgent 2000 → **total ₹45.00 (4500 paise)**
(This exact case is asserted in `tests/integration/full-flow.test.ts`.)

## Trust model
- The portal shows a live estimate from `POST /api/public/quote` (same engine).
- `POST /api/public/orders` **recomputes** the price from DB settings + server page counts and compares it with
  `expectedTotalPaise` the customer saw. Any difference → `409 PRICE_MISMATCH` with the fresh quote; nothing is
  stored. Client-supplied prices are never used.
- Staff edits of settings re-price the item server-side, update order totals, and write
  `order_item_revisions` + `audit_logs`. The new total can never drop below what has already been paid.
