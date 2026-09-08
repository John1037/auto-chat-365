-- Tenant knowledge-base documents and their embedded chunks (the vector store).

create extension if not exists vector;

create table tenant_documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  title text,
  source_type text not null check (source_type in ('text', 'url', 'upload')),
  raw_content text,
  status text not null default 'pending' check (status in ('pending', 'processing', 'ready', 'error')),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index tenant_documents_tenant_id_idx on tenant_documents (tenant_id);

-- text-embedding-3-small produces 1536-dim vectors.
create table tenant_document_chunks (
  id uuid primary key default gen_random_uuid(),
  -- Denormalized from tenant_documents: every retrieval query filters on this directly.
  tenant_id uuid not null references tenants(id) on delete cascade,
  document_id uuid not null references tenant_documents(id) on delete cascade,
  chunk_index int not null,
  content text not null,
  embedding vector(1536) not null,
  created_at timestamptz not null default now()
);

create index tenant_document_chunks_tenant_id_idx on tenant_document_chunks (tenant_id);
create index tenant_document_chunks_embedding_idx
  on tenant_document_chunks using hnsw (embedding vector_cosine_ops);

create function tenant_document_chunks_check_tenant_consistency() returns trigger
  language plpgsql as $$
begin
  if not exists (
    select 1 from tenant_documents d
    where d.id = new.document_id
      and d.tenant_id = new.tenant_id
  ) then
    raise exception 'tenant_document_chunks.tenant_id must match the parent document';
  end if;
  return new;
end;
$$;

create trigger tenant_document_chunks_tenant_consistency
  before insert or update on tenant_document_chunks
  for each row execute function tenant_document_chunks_check_tenant_consistency();
