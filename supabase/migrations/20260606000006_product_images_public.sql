-- Product/menu images are shown on the public QR ordering page (unauthenticated),
-- so the bucket must serve public read URLs. Writes remain restricted by the
-- existing manager+ storage policies (org/store path guard).
update storage.buckets set public = true where id = 'product-images';
