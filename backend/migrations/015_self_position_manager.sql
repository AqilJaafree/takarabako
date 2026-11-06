-- Self-custody positions held by an AquaPositionManager (contracts/src/AquaPositionManager.sol).
-- With a manager, the manager (not the customer's wallet) is the Aqua maker, so the strategies'
-- balances are read under its address, and closing needs the position's id inside the manager,
-- which is known once the open transaction is mined. Both stay null for wallet-as-maker positions.
alter table self_positions add column if not exists manager text;
alter table self_positions add column if not exists manager_position_id numeric;
