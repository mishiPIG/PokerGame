ALTER TABLE users ADD COLUMN display_name TEXT;
ALTER TABLE users ADD COLUMN display_name_changed_at_ms INTEGER;

UPDATE users
SET display_name = username
WHERE display_name IS NULL OR display_name = '';
