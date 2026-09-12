-- Storage for uploaded widget logos. Public bucket (readable by anyone with the
-- object's URL, no auth) -- the widget script is an anonymous embed on arbitrary
-- tenant domains, so the logo image must load via a plain public URL. Nothing writes
-- to this bucket except the Worker's upload-widget-logo route via the service-role
-- client (same "sensitive writes go through a server route" pattern as everywhere
-- else -- see widget_documents, create-widget), so no storage.objects RLS policies
-- are needed for authenticated/anon: service_role already bypasses RLS.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('widget-logos', 'widget-logos', true, 2097152, array['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'])
on conflict (id) do nothing;
