-- Phone search was a plain ILIKE substring match against the raw `phone`
-- column, so formatting differences (hyphens, spaces, parens, dots) between
-- what's stored and what staff type prevented an otherwise-matching number
-- from being found. This strips everything but digits before comparing, on
-- both sides, so "555-123-4567", "(555) 123-4567", and "5551234567" are all
-- treated as the same search.
CREATE OR REPLACE FUNCTION normalize_phone_digits(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT regexp_replace(coalesce(p_value, ''), '\D', '', 'g');
$$;
