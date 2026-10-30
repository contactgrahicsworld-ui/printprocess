-- Customer UPI payment claim: after paying to the shop's UPI QR, the customer submits the
-- UTR/reference from the tracking page; staff verify it against their UPI app and record the payment.
alter table public.orders add column if not exists payment_claim jsonb;
