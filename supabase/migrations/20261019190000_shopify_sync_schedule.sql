-- Drain the Shopify sync queue every minute; full reconciliation nightly
-- at 00:30 UTC (03:30 Israel summer time / 02:30 winter time).
select cron.unschedule(jobid) from cron.job where jobname in ('shopify-sync-queue', 'shopify-sync-nightly');
select cron.schedule('shopify-sync-queue', '* * * * *', $$select public.shopify_sync_kick('queue')$$);
select cron.schedule('shopify-sync-nightly', '30 0 * * *', $$select public.shopify_sync_kick('full')$$);

-- pg_net keeps responses; keep the table small.
select cron.unschedule(jobid) from cron.job where jobname = 'net-http-response-cleanup';
select cron.schedule('net-http-response-cleanup', '15 1 * * *',
  $$delete from net._http_response where created < now() - interval '2 days'$$);
