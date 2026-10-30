-- Default settings (edit in Admin → Settings). Rates are in paise.
insert into public.shop_settings (id, shop_name, address) values (1, 'Mansa Printer', 'Bhilai, Chhattisgarh')
on conflict (id) do nothing;

-- A4 per printed side: B/W ₹2.00 single-sided, ₹1.50 per side when double-sided; colour ₹10.00 / ₹9.00.
insert into public.price_settings (id, bw_single_side_paise, bw_double_side_paise, color_single_side_paise, color_double_side_paise, min_order_paise)
values (1, 200, 150, 1000, 900, 0)
on conflict (id) do nothing;

insert into public.paper_size_rates (paper_size, multiplier_bp, enabled) values
  ('A4', 10000, true), ('A3', 20000, true), ('LEGAL', 12500, true)
on conflict (paper_size) do nothing;

insert into public.paper_types (name, surcharge_per_sheet_paise, active, sort_order) values
  ('Normal 70 GSM', 0, true, 1), ('Bond 90 GSM', 100, true, 2), ('Art paper 130 GSM', 500, true, 3)
on conflict (name) do nothing;

insert into public.services (code, name, unit, amount_paise, active, sort_order) values
  ('STAPLE', 'Stapling / Staple', 'PER_COPY', 200, true, 1),
  ('SPIRAL', 'Spiral binding / Spiral', 'PER_COPY', 3000, true, 2),
  ('URGENT', 'Urgent / Turant', 'PER_ORDER', 2000, true, 3)
on conflict (code) do nothing;
