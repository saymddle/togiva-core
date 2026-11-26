-- 0010_loyalty_engine: what the Phase 4 loyalty engine needs on top of 0006.

-- Points from a purchase become spendable after the program version's
-- pendingPeriodSeconds (refund window). Debits are effective immediately.
-- Null means "available at occurred_at".
alter table togiva.loyalty_ledger add column available_at timestamptz;

-- A refund after the member has already spent the points leaves a negative
-- balance (a debt repaid by future earning) rather than an untrue ledger. The
-- projection must be able to show that.
alter table togiva.loyalty_balance_projections drop constraint if exists loyalty_balance_projections_available_points_check;

create index loyalty_ledger_account_source on togiva.loyalty_ledger (loyalty_account_id, source_type, source_id);

-- Balance computed straight from the ledger. The projection table is a cache
-- of this; reconciliation compares the two.
create or replace function togiva.loyalty_ledger_balance(p_account_id uuid, p_at timestamptz default now())
returns table (available_points bigint, pending_points bigint, lifetime_earned_points bigint, lifetime_redeemed_points bigint, last_ledger_entry_id bigint)
language sql stable as $$
  select
    coalesce(sum(points) filter (where coalesce(available_at, occurred_at) <= p_at), 0)::bigint,
    coalesce(sum(points) filter (where coalesce(available_at, occurred_at) > p_at), 0)::bigint,
    coalesce(sum(points) filter (where entry_type in ('earn', 'bonus', 'refund_reversal', 'void_reversal')), 0)::bigint,
    coalesce(-sum(points) filter (where entry_type in ('redeem', 'redeem_reversal')), 0)::bigint,
    max(id)
  from togiva.loyalty_ledger where loyalty_account_id = p_account_id
$$;

create or replace function togiva.refresh_loyalty_projection(p_account_id uuid) returns void
language sql as $$
  insert into togiva.loyalty_balance_projections as p (loyalty_account_id, organization_id, available_points, pending_points,
    lifetime_earned_points, lifetime_redeemed_points, last_ledger_entry_id, updated_at)
  select a.id, a.organization_id, b.available_points, b.pending_points, b.lifetime_earned_points, b.lifetime_redeemed_points, b.last_ledger_entry_id, now()
    from togiva.loyalty_accounts a cross join lateral togiva.loyalty_ledger_balance(a.id) b
   where a.id = p_account_id
  on conflict (loyalty_account_id) do update set
    available_points = excluded.available_points, pending_points = excluded.pending_points,
    lifetime_earned_points = excluded.lifetime_earned_points, lifetime_redeemed_points = excluded.lifetime_redeemed_points,
    last_ledger_entry_id = excluded.last_ledger_entry_id, updated_at = now()
$$;

-- When the POS reports a refund or void on a sale a member was credited for,
-- queue a recompute. Provider-independent: whichever POS pipeline updates
-- pos_transactions triggers this.
create or replace function togiva.queue_loyalty_transaction_change() returns trigger
language plpgsql security definer set search_path = togiva, pg_temp as $$
begin
  if (new.status is distinct from old.status or new.refunded_minor is distinct from old.refunded_minor)
     and new.status in ('partially_refunded', 'refunded', 'voided')
     and exists (select 1 from customer_transaction_associations a where a.pos_transaction_id = new.id and a.status = 'confirmed') then
    perform enqueue_job('loyalty.process_transaction_change',
      jsonb_build_object('posTransactionId', new.id),
      new.organization_id,
      format('loyalty-txn:%s:%s:%s', new.id, new.status, new.refunded_minor));
  end if;
  return new;
end $$;
create trigger pos_transactions_loyalty_change after update on togiva.pos_transactions
  for each row execute function togiva.queue_loyalty_transaction_change();

-- Expiry sweep for unredeemed reward tokens.
create index reward_redemptions_issued_expiry on togiva.reward_redemptions (expires_at) where status = 'issued';
