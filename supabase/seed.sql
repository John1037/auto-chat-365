-- Local-dev seed: two demo tenants, each with one anonymous visitor, one
-- conversation/message, and one knowledge-base document containing a fact unique to
-- that tenant. Used by the M1 manual RLS walkthrough and as fixtures for
-- scripts/test-isolation.mjs. Embedding vectors here are placeholders (seed.sql can't
-- call the OpenAI API) -- fine for proving row-visibility isolation, not meant to
-- exercise real semantic retrieval quality (that's what M2's ingest-document +
-- OpenAI-backed test is for).

insert into tenants (id, name) values
  ('11111111-1111-1111-1111-111111111111', 'Tenant A Demo Co'),
  ('22222222-2222-2222-2222-222222222222', 'Tenant B Demo Co');

insert into widgets (id, tenant_id, name, site_key, allowed_origins) values
  ('a1111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'Default widget', 'sk_live_demo_tenant_a', '{http://localhost:8080}'),
  ('b2222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', 'Default widget', 'sk_live_demo_tenant_b', '{http://localhost:8080}');

-- Minimal anonymous auth.users rows, mirroring what signInAnonymously() would create.
-- widget_sessions.id must reference a real auth.users row (see 0001_core_schema.sql).
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, is_anonymous, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
) values
  (
    '00000000-0000-0000-0000-000000000000',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'authenticated', 'authenticated', null, '',
    now(), true, '{"provider":"anonymous","providers":["anonymous"]}', '{}',
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    'authenticated', 'authenticated', null, '',
    now(), true, '{"provider":"anonymous","providers":["anonymous"]}', '{}',
    now(), now()
  );

insert into widget_sessions (id, tenant_id, widget_id, origin) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', 'http://localhost:8080'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'b2222222-2222-2222-2222-222222222222', 'http://localhost:8080');

insert into conversations (id, tenant_id, session_id) values
  ('c1111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  ('c2222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');

insert into messages (conversation_id, tenant_id, session_id, role, content) values
  ('c1111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'user', 'What is Tenant A''s secret launch date?'),
  ('c1111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'assistant', 'Tenant A''s secret launch date is 2027-03-14.'),
  ('c2222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'user', 'What is Tenant B''s secret launch date?'),
  ('c2222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'assistant', 'Tenant B''s secret launch date is 2027-09-01.');

insert into tenant_documents (id, tenant_id, title, source_type, raw_content, status) values
  ('d1111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'Launch facts', 'text', 'Tenant A''s secret launch date is 2027-03-14.', 'ready'),
  ('d2222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', 'Launch facts', 'text', 'Tenant B''s secret launch date is 2027-09-01.', 'ready');

insert into tenant_document_chunks (tenant_id, document_id, chunk_index, content, embedding) values
  (
    '11111111-1111-1111-1111-111111111111',
    'd1111111-1111-1111-1111-111111111111',
    0,
    'Tenant A''s secret launch date is 2027-03-14.',
    array_fill(0.01, array[1536])::vector
  ),
  (
    '22222222-2222-2222-2222-222222222222',
    'd2222222-2222-2222-2222-222222222222',
    0,
    'Tenant B''s secret launch date is 2027-09-01.',
    array_fill(0.02, array[1536])::vector
  );
