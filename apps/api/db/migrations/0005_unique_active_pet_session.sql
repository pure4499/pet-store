-- A pet can only have one currently active stay within its organization.
CREATE UNIQUE INDEX uq_active_session_per_pet
  ON sessions (organization_id, pet_id)
  WHERE status = 'active';
