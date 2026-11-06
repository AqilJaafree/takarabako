-- Aqua positions can use the hybrid shape (a tight core plus a full-range
-- tail). Runs at every startup like the other migrations: drop, then add.
alter table aqua_positions drop constraint if exists aqua_positions_shape_check;
alter table aqua_positions add constraint aqua_positions_shape_check
  check (shape in ('full', 'spot', 'curve', 'bidask', 'hybrid'));
