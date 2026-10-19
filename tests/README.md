Business rules:

```sh
node --test tests/business-rules.test.mjs
deno test --no-check --allow-env --allow-net tests/icount-invoice.test.ts
```

The iCount tests replace all network calls with fixtures, and assert that blocked
requests cause neither document creation nor database writes. The Edge Function
can be type checked separately with `deno check supabase/functions/icount-invoice/index.ts`.

After applying the catalog migration, database integration assertions can be run
with `supabase db query --linked --file tests/catalog-rules.sql`. All changes,
including temporary contacts and catalog preferences, run inside a rollback.
