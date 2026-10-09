-- Give every facility a useful starter set of physical collar colors. Each row
-- receives its own UUID, which is also the permanent identity encoded in the
-- collar's tailtells:// QR payload.
INSERT INTO organization_collar_palette (organization_id, color_name, color_hex)
SELECT organization.id, color.name, color.hex
FROM organizations AS organization
CROSS JOIN (VALUES
  ('Red',    '#D83A34'),
  ('Blue',   '#2F6FE4'),
  ('Green',  '#2E9B55'),
  ('Yellow', '#F4C542'),
  ('Orange', '#F28C28')
) AS color(name, hex)
ON CONFLICT (organization_id, color_name) DO NOTHING;

-- New facilities should receive the same starter set automatically.
CREATE OR REPLACE FUNCTION seed_default_collar_palette()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO organization_collar_palette (organization_id, color_name, color_hex)
  VALUES
    (NEW.id, 'Red',    '#D83A34'),
    (NEW.id, 'Blue',   '#2F6FE4'),
    (NEW.id, 'Green',  '#2E9B55'),
    (NEW.id, 'Yellow', '#F4C542'),
    (NEW.id, 'Orange', '#F28C28')
  ON CONFLICT (organization_id, color_name) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_seed_default_collar_palette ON organizations;
CREATE TRIGGER trg_seed_default_collar_palette
AFTER INSERT ON organizations
FOR EACH ROW
EXECUTE FUNCTION seed_default_collar_palette();
