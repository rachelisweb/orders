-- Remove the original archived winter import after the corrected Excel orders
-- were recreated as future-season orders (#92-#101). The exact IDs and guards
-- keep this cleanup idempotent and prevent deletion outside the audited set.

delete from public.orders
where id in (
  'ed47e2e4-83bc-4f57-b3ef-e96b0fb7d199',
  'd7bcd69f-0124-4634-b188-c5d356b08052',
  '4044ea53-f7f5-4337-a336-8f8b4b0f5404',
  '512e8e8a-3736-4211-80b9-81a323db9355',
  '0235afcc-29d9-4bb6-81e9-de4f5c5e5e6e',
  '09936f74-5a05-4ec9-b735-8aa7a9909d32',
  'd00ed264-cc6e-4b16-94b9-c3b85aee273c',
  '7462cf75-a9db-46f5-9167-0f1d38ed7276',
  '38dafcb3-b100-4688-a91b-2e115de080e7',
  'd7f88547-dd59-4ea1-afe0-b5090ea4d364',
  '3a5dedd0-2cee-4173-bf51-76f17eb8cd3c'
)
  and archived_at is not null
  and source = 'import'
  and order_number between 5 and 15
  and coalesce(notes, '') not like '%rachelis-winter-next-season-v1%';
