-- The network a customer picked in the app: their notes are credited and their tkCASH minted
-- there. Null means they haven't picked one, so the kiosk's home chain decides.
alter table accounts add column if not exists deposit_chain text;
