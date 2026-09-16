-- Drops image/svg+xml from the widget-logos bucket's own allowed_mime_types, to
-- match widgetImageUpload.ts's app-level ALLOWED_TYPES. SVG is XML and can carry
-- <script>/event-handler content; this bucket is public (readable by anyone with the
-- object's URL, no auth) and serves objects back with whatever content-type they
-- were uploaded as, so accepting it would mean serving a visitor-uploadable stored-
-- XSS vector at a stable public URL. This is the second, storage-level layer of that
-- same restriction -- defense in depth, not relying on the app-level check alone.
update storage.buckets
set allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp']
where id = 'widget-logos';
