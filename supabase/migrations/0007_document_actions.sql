-- Adds the pieces needed for real document management: a 'stale' status (content
-- edited since the last successful embed, needs re-embedding), a distinct
-- embedded_at timestamp (created_at is when the row/document was first added, which
-- drifts from the truth once a document has been edited and re-embedded), and the
-- similarity-search RPC chat.ts has been calling defensively (wrapped in try/catch)
-- since M2, waiting for this migration to land.

alter table tenant_documents drop constraint tenant_documents_status_check;
alter table tenant_documents add constraint tenant_documents_status_check
  check (status in ('pending', 'processing', 'ready', 'stale', 'error'));

alter table tenant_documents add column embedded_at timestamptz;

-- Tenant-scoped cosine-similarity search over tenant_document_chunks. Called by the
-- chat route via the secret-key client, which bypasses RLS entirely -- the explicit
-- p_tenant_id filter here IS the enforcement, same defense-in-depth pattern as every
-- other privileged query in this project. security definer so it can be called
-- without granting direct table access to any client role.
create function match_tenant_document_chunks(
  p_tenant_id uuid,
  p_query_embedding vector(1536),
  p_match_count int
) returns table (
  id uuid,
  document_id uuid,
  content text,
  similarity float
)
  language sql
  security definer
  set search_path = public
as $$
  select
    c.id,
    c.document_id,
    c.content,
    1 - (c.embedding <=> p_query_embedding) as similarity
  from tenant_document_chunks c
  where c.tenant_id = p_tenant_id
  order by c.embedding <=> p_query_embedding
  limit p_match_count;
$$;
