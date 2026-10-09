-- Embeddings from different backbones do not share a coordinate space, even
-- when their stored vectors have the same width. Persist the producing model
-- so DINOv2 can be evaluated and rolled out without comparing it to legacy
-- ResNet-18 references.

ALTER TABLE photo_detections
  ADD COLUMN embedding_model text NOT NULL DEFAULT 'resnet18-imagenet-v1';

ALTER TABLE pet_reference_embeddings
  ADD COLUMN embedding_model text NOT NULL DEFAULT 'resnet18-imagenet-v1';

CREATE INDEX ix_ref_embeddings_model_pet
  ON pet_reference_embeddings (organization_id, embedding_model, pet_id)
  WHERE is_active;

COMMENT ON COLUMN photo_detections.embedding_model IS
  'Versioned feature space used to produce embedding; never compare across versions.';
COMMENT ON COLUMN pet_reference_embeddings.embedding_model IS
  'Versioned feature space used to produce embedding; matching filters to the query model.';
