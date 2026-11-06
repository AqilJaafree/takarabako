-- Self-custody positions on more than one pair (a base token against USDC): which pair a position is in.
-- Null is the chain's default pair (Arc: WETH/USDC, Sepolia: mETH/mUSDC), which is every position made
-- before pairs existed, so nothing needs backfilling.
alter table self_positions add column if not exists pair text;
