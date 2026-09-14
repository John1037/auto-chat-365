-- widget_documents' only index is its primary key (widget_id, document_id), which
-- only serves lookups led by widget_id efficiently. Every "which widgets can see
-- this document" query -- the existing visibility dialog, and the upload-time
-- visibility picker this migration accompanies -- filters by document_id alone, not
-- covered by that composite index's leading column. Matters once this table has
-- real volume (tens of thousands of documents, each potentially scoped to several
-- widgets) rather than the small local/dev row counts seen so far.
create index widget_documents_document_id_idx on widget_documents (document_id);
