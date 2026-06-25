-- Receipt header logo + footer image (e.g. a LINE / static-QR image).
-- logo_url already exists on receipt_settings; add the footer image column.
-- Both are public URLs (product-images bucket) so the raster renderer can draw
-- them onto a canvas without tainting it.
alter table receipt_settings
  add column if not exists footer_image_url text;
